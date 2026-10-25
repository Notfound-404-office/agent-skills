export interface WasmInitializer {
  default(options: { module_or_path: Promise<Response> | Response | URL | string }): Promise<unknown>;
}

export const n: WasmInitializer;
