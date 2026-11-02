export type local_to_remote_port_mapping_t = {
  local_tcp_port: number;
  remote_tcp_port: number;
  local_bind_address?: string | undefined;
  remote_bind_address?: string | undefined;
};

export type remote_to_local_port_mapping_t = {
  remote_tcp_port: number;
  local_tcp_port: number;
  remote_bind_address?: string | undefined;
  local_bind_address?: string | undefined;
};

export type username_password_auth_t = {
  username: string;
  password: string;
  auth_type?: 'username_password' | undefined;
};

export type private_key_auth_t = {
  username: string;
  private_key: string | Buffer;
  passphrase?: string | undefined;
  auth_type?: 'private_key' | undefined;
};

export type ssh_auth_t = username_password_auth_t | private_key_auth_t;

export type reconnect_strategy_t = {
  enabled: boolean;
  base_interval_ms: number;
  max_interval_ms: number;
  max_attempts: number | 'infinite';
  jitter_ratio: number;
};

export type tcp_endpoint_t = {
  endpoint_type: 'tcp';
  tcp_port: number;
  bind_address?: string | undefined;
};

export type unix_socket_endpoint_t = {
  endpoint_type: 'unix_socket';
  socket_path: string;
};

export type tunnel_endpoint_t = tcp_endpoint_t | unix_socket_endpoint_t;

export type local_to_remote_endpoint_mapping_t = {
  local_endpoint: tunnel_endpoint_t;
  remote_endpoint: tunnel_endpoint_t;
};

export type remote_to_local_endpoint_mapping_t = {
  remote_endpoint: tunnel_endpoint_t;
  local_endpoint: tunnel_endpoint_t;
};

export type tunnel_definition_t = {
  name: string;
  host: string;
  port: number;
  ready_timeout_ms?: number | undefined;
  keepalive_interval_ms?: number | undefined;
  keepalive_count_max?: number | undefined;
  local_to_remote_port_mappings: local_to_remote_port_mapping_t[];
  remote_to_local_port_mappings: remote_to_local_port_mapping_t[];
  local_to_remote_endpoint_mappings?:
    | local_to_remote_endpoint_mapping_t[]
    | undefined;
  remote_to_local_endpoint_mappings?:
    | remote_to_local_endpoint_mapping_t[]
    | undefined;
  reconnect_strategy?: reconnect_strategy_t | undefined;
  auth: ssh_auth_t;
};

export type tunnel_definition_input_t = {
  name: string;
  host: string;
  port: number;
  ready_timeout_ms?: number | undefined;
  keepalive_interval_ms?: number | undefined;
  keepalive_count_max?: number | undefined;
  local_to_remote_port_mappings?: local_to_remote_port_mapping_t[] | undefined;
  remote_to_local_port_mappings?: remote_to_local_port_mapping_t[] | undefined;
  local_to_remote_endpoint_mappings?:
    | local_to_remote_endpoint_mapping_t[]
    | undefined;
  remote_to_local_endpoint_mappings?:
    | remote_to_local_endpoint_mapping_t[]
    | undefined;
  reconnect_strategy?: reconnect_strategy_t | undefined;
  auth: ssh_auth_t;
};

export type tunnel_runtime_state_t =
  | 'defined'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'failed';

export interface tunnel_reconnect_info_i {
  enabled: boolean;
  base_interval_ms: number;
  max_interval_ms: number;
  max_attempts: number | 'infinite';
  jitter_ratio: number;
  attempt_count: number;
  last_attempt_at_iso_8601?: string | undefined;
  last_scheduled_delay_ms?: number | undefined;
}

export interface tunnel_status_i {
  name: string;
  host: string;
  port: number;
  state: tunnel_runtime_state_t;
  local_to_remote_port_mappings: local_to_remote_port_mapping_t[];
  remote_to_local_port_mappings: remote_to_local_port_mapping_t[];
  local_to_remote_endpoint_mappings: local_to_remote_endpoint_mapping_t[];
  remote_to_local_endpoint_mappings: remote_to_local_endpoint_mapping_t[];
  last_error_message?: string | undefined;
  reconnect_attempt_count: number;
  reconnect_info: tunnel_reconnect_info_i;
  established_at_iso_8601?: string | undefined;
  disconnected_at_iso_8601?: string | undefined;
  updated_at_iso_8601: string;
}

export interface tunnel_establishment_failure_i {
  name: string;
  error_code: string;
  error_message: string;
}

export interface tunnel_establishment_summary_i {
  established_tunnels: string[];
  failed_tunnels: tunnel_establishment_failure_i[];
  skipped_tunnels: string[];
  started_at_iso_8601: string;
  completed_at_iso_8601: string;
}
