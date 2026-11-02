import type {
  local_to_remote_endpoint_mapping_t,
  local_to_remote_port_mapping_t,
  remote_to_local_endpoint_mapping_t,
  remote_to_local_port_mapping_t,
  tunnel_status_i
} from '@src/types/ssh_tunnel.types';

export type tunnel_forward_direction_t =
  | 'local_to_remote'
  | 'remote_to_local';

export type tunnel_forward_mapping_t =
  | local_to_remote_port_mapping_t
  | remote_to_local_port_mapping_t;

export type tunnel_forward_endpoint_mapping_t =
  | local_to_remote_endpoint_mapping_t
  | remote_to_local_endpoint_mapping_t;

export interface tunnel_connected_event_i {
  tunnel_name: string;
  status: tunnel_status_i;
}

export interface tunnel_disconnected_event_i {
  tunnel_name: string;
  status: tunnel_status_i;
  reason: string;
}

export interface tunnel_reconnecting_event_i {
  tunnel_name: string;
  attempt_count: number;
  scheduled_delay_ms: number;
}

export interface tunnel_reconnect_failed_event_i {
  tunnel_name: string;
  attempt_count: number;
  error_message: string;
  will_retry: boolean;
}

export interface tunnel_forward_established_event_i {
  tunnel_name: string;
  direction: tunnel_forward_direction_t;
  endpoint_mapping: tunnel_forward_endpoint_mapping_t;
  mapping?: tunnel_forward_mapping_t | undefined;
}

export interface tunnel_forward_failed_event_i {
  tunnel_name: string;
  direction: tunnel_forward_direction_t;
  endpoint_mapping: tunnel_forward_endpoint_mapping_t;
  mapping?: tunnel_forward_mapping_t | undefined;
  error_message: string;
}

export interface ssh_tunnel_runtime_event_map_i {
  connected: tunnel_connected_event_i;
  disconnected: tunnel_disconnected_event_i;
  reconnecting: tunnel_reconnecting_event_i;
  reconnect_failed: tunnel_reconnect_failed_event_i;
  forward_established: tunnel_forward_established_event_i;
  forward_failed: tunnel_forward_failed_event_i;
}

export type ssh_tunnel_runtime_event_name_t = keyof ssh_tunnel_runtime_event_map_i;
