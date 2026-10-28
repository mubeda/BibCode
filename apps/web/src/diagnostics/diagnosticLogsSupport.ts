import type { ServerConfig } from "@bibcode/contracts";

/**
 * Whether the server sends its diagnostic bundle over RPC (`server.downloadDiagnosticLogs`).
 * An older server fails the whole connection on a method it does not know, so a client asks
 * only a server that says it has it.
 */
export function serverHasDiagnosticLogs(serverConfig: ServerConfig | null | undefined): boolean {
  return serverConfig?.environment.capabilities.diagnosticLogs === true;
}
