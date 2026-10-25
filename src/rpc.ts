import { Duplex } from "node:stream";
import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";
import WebSocket from "ws";

export interface RpcMessage {
  method: string;
  params: unknown;
  id?: string | number;
}

export interface RpcClient {
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params: unknown): Promise<void>;
  respond(id: string | number, result: unknown): Promise<void>;
  onMessage(listener: (message: RpcMessage) => void): () => void;
  onClose(listener: (error: Error) => void): () => void;
  close(): Promise<void>;
}

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 128;
const REQUEST_TIMEOUT_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;
const MAX_STDERR_BYTES = 16 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validId(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

export async function connectRpc(launch: ProviderLaunch): Promise<RpcClient> {
  const child = spawnProcess(launch.command, launch.args, { env: launch.env, stdio: "pipe" });
  const pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const writes = new Set<(error: Error) => void>();
  const messageListeners = new Set<(message: RpcMessage) => void>();
  const closeListeners = new Set<(error: Error) => void>();
  let nextId = 0;
  let websocket: WebSocket | undefined;
  let stderr = Buffer.alloc(0);
  let failure: Error | undefined;
  let shutdown: Promise<void> | undefined;
  let exited = false;

  function diagnostic(error: Error): Error {
    return stderr.length === 0
      ? error
      : new Error(`${error.message}\nProxy stderr: ${stderr.toString("utf8")}`, { cause: error });
  }

  function fail(error: Error): void {
    if (failure) return;
    failure = diagnostic(error);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(failure);
    }
    pending.clear();
    for (const reject of writes) reject(failure);
    writes.clear();
    for (const listener of closeListeners) {
      try {
        listener(failure);
      } catch (listenerError) {
        process.emitWarning(new Error("RPC close listener threw", { cause: listenerError }));
      }
    }
  }

  async function close(): Promise<void> {
    if (shutdown) return shutdown;
    shutdown = Promise.resolve().then(async () => {
      websocket?.terminate();
      if (exited) return;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          void terminateProcess(child).then(resolve, reject);
        }, SHUTDOWN_TIMEOUT_MS);
        child.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        void terminateProcess(child, "SIGTERM").catch((error: unknown) => {
          clearTimeout(timer);
          reject(error);
        });
      });
    });
    fail(new Error("RPC connection closed"));
    return shutdown;
  }

  function abort(error: Error): void {
    fail(error);
    void close().catch((closeError: unknown) =>
      process.emitWarning(new Error("Failed to stop RPC proxy", { cause: closeError })),
    );
  }

  function receive(frame: Buffer): void {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame));
    if (!record(value)) throw new Error("RPC frame must be an object");
    if ("jsonrpc" in value && value["jsonrpc"] !== "2.0") throw new Error("Invalid RPC version");
    if ("method" in value) {
      if (
        typeof value["method"] !== "string" ||
        value["method"].length === 0 ||
        ("id" in value && !validId(value["id"]))
      )
        throw new Error("Invalid RPC server request");
      const message: RpcMessage = { method: value["method"], params: value["params"] };
      if (validId(value["id"])) message.id = value["id"];
      for (const listener of messageListeners) listener(message);
      return;
    }
    const hasResult = Object.hasOwn(value, "result");
    const hasError = Object.hasOwn(value, "error");
    if (!validId(value["id"]) || hasResult === hasError) throw new Error("Invalid RPC response");
    const rpcError = value["error"];
    if (
      "error" in value &&
      (!record(rpcError) ||
        typeof rpcError["message"] !== "string" ||
        typeof rpcError["code"] !== "number")
    )
      throw new Error("Invalid RPC error response");
    const request = typeof value["id"] === "number" ? pending.get(value["id"]) : undefined;
    // Replies to timed-out operations cannot be replayed or assigned to another request.
    if (!request) return;
    pending.delete(value["id"] as number);
    clearTimeout(request.timer);
    if (record(rpcError))
      request.reject(
        new Error(`RPC error ${String(rpcError["code"])}: ${String(rpcError["message"])}`),
      );
    else request.resolve(value["result"]);
  }

  child.stderr.on("data", (chunk: Buffer) => {
    stderr = Buffer.concat([stderr, chunk]).subarray(-MAX_STDERR_BYTES);
  });
  child.stdout.on("error", (error: Error) => abort(error));
  child.stdin.on("error", (error: Error) => abort(error));
  child.stderr.on("error", (error: Error) => abort(error));
  child.on("error", (error: Error) => abort(error));
  child.on("close", (code, signal) => {
    exited = true;
    fail(new Error(`RPC proxy exited (code ${String(code)}, signal ${String(signal)})`));
  });

  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });

  const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
  websocket = new WebSocket("ws://localhost/", {
    createConnection: () => stream,
    handshakeTimeout: REQUEST_TIMEOUT_MS,
    maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: false,
    followRedirects: false,
  });
  const socket = websocket;
  socket.on("message", (data, isBinary) => {
    if (failure) return;
    try {
      if (isBinary) throw new Error("Unexpected binary RPC message; compression is disabled");
      const frame = Array.isArray(data)
        ? Buffer.concat(data)
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : data;
      receive(frame);
    } catch (error) {
      abort(
        new Error(
          `Invalid RPC proxy output: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        ),
      );
    }
  });
  socket.on("error", (error: Error) =>
    abort(new Error(`RPC WebSocket failed: ${error.message}`, { cause: error })),
  );
  socket.on("close", (code, reason) =>
    abort(
      new Error(
        `RPC WebSocket closed (code ${code}${reason.length ? `, ${reason.toString()}` : ""})`,
      ),
    ),
  );
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
    socket.once("close", () =>
      reject(failure ?? new Error("RPC WebSocket closed during handshake")),
    );
  });

  function write(message: unknown): Promise<void> {
    if (failure) return Promise.reject(failure);
    if (writes.size >= MAX_PENDING_REQUESTS)
      return Promise.reject(new Error("RPC write capacity exceeded"));
    let frame: string;
    try {
      frame = JSON.stringify(message);
    } catch (error) {
      return Promise.reject(new Error("RPC message cannot be serialized", { cause: error }));
    }
    const frameBytes = Buffer.byteLength(frame);
    if (frameBytes > MAX_FRAME_BYTES)
      return Promise.reject(new Error("RPC frame exceeds 8 MiB limit"));
    if (socket.bufferedAmount + frameBytes > MAX_FRAME_BYTES)
      return Promise.reject(new Error("RPC outgoing byte capacity exceeded"));
    return new Promise<void>((resolve, reject) => {
      const rejectWrite = (error: Error) => {
        clearTimeout(timer);
        writes.delete(rejectWrite);
        reject(error);
      };
      const timer = setTimeout(() => {
        const error = new Error("RPC proxy write timed out; operation outcome is unknown");
        rejectWrite(error);
        abort(error);
      }, REQUEST_TIMEOUT_MS);
      writes.add(rejectWrite);
      socket.send(frame, { binary: false, compress: false }, (error) => {
        clearTimeout(timer);
        writes.delete(rejectWrite);
        if (error) {
          reject(error);
          abort(error);
        } else resolve();
      });
    });
  }

  return {
    request(method, params) {
      if (failure) return Promise.reject(failure);
      if (pending.size >= MAX_PENDING_REQUESTS)
        return Promise.reject(new Error("RPC pending request capacity exceeded"));
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(
            new Error(
              `RPC ${method} timed out after ${REQUEST_TIMEOUT_MS} ms; operation outcome is unknown`,
            ),
          );
        }, REQUEST_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        void write({ id, method, params }).catch((error: unknown) => {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        });
      });
    },
    respond(id, result) {
      return write({ id, result });
    },
    notify(method, params) {
      return write({ method, params });
    },
    onMessage(listener) {
      messageListeners.add(listener);
      return () => {
        messageListeners.delete(listener);
      };
    },
    onClose(listener) {
      closeListeners.add(listener);
      if (failure) listener(failure);
      return () => {
        closeListeners.delete(listener);
      };
    },
    close,
  };
}
