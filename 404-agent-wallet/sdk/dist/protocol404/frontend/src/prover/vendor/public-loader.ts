/** Load generated public chunks in browsers, or their checked-in files under Node. */
export async function importPublic(path: string): Promise<unknown> {
  try {
    return await import(path);
  } catch (error) {
    if (typeof window !== "undefined") throw error;
    // From src/prover/vendor, ../../../public is the browser's public root.
    const hostFile = new URL(`../../../public${path}`, import.meta.url);
    return import(hostFile.href);
  }
}
