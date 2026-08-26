import { UpdateMaintenanceActiveError, WsRpcGroup } from "@bibcode/contracts";
import * as Effect from "effect/Effect";
import { RpcClient } from "effect/unstable/rpc";
import * as RpcMiddleware from "effect/unstable/rpc/RpcMiddleware";
import * as RpcMessage from "effect/unstable/rpc/RpcMessage";

let nextRequestId = 0n;

class UpdateMaintenanceAdmission extends RpcMiddleware.Service<UpdateMaintenanceAdmission>()(
  "@bibcode/client-runtime/rpc/UpdateMaintenanceAdmission",
  { error: UpdateMaintenanceActiveError },
) {}

export const WsRpcClientGroup = WsRpcGroup.middleware(UpdateMaintenanceAdmission);

export const makeWsRpcProtocolClient = RpcClient.make(WsRpcClientGroup, {
  generateRequestId: () => RpcMessage.RequestId(String(nextRequestId++)),
});
type RpcClientFactory = typeof makeWsRpcProtocolClient;
export type WsRpcProtocolClient =
  RpcClientFactory extends Effect.Effect<infer Client, any, any> ? Client : never;
