import type { tunnel_definition_t, tunnel_status_i } from '@src/types/ssh_tunnel.types';

export interface tunnel_runtime_i {
  connect(): Promise<tunnel_status_i>;
  disconnect(): Promise<tunnel_status_i>;
  getStatus(): tunnel_status_i;
}

export type tunnel_runtime_factory_t = (params: {
  tunnel_definition: tunnel_definition_t;
}) => tunnel_runtime_i;

export interface ssh_tunnel_manager_dependencies_i {
  tunnel_runtime_factory?: tunnel_runtime_factory_t | undefined;
}
