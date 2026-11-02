import { lstat, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createServer, connect } from 'node:net';
import type { Server, Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import { setTimeout as Delay } from 'node:timers/promises';

import { SSHTunnelError } from '@src/errors/SSHTunnelError.class';
import type {
  local_to_remote_endpoint_mapping_t,
  local_to_remote_port_mapping_t,
  reconnect_strategy_t,
  remote_to_local_endpoint_mapping_t,
  remote_to_local_port_mapping_t,
  ssh_auth_t,
  tunnel_endpoint_t,
  tunnel_definition_t,
  tunnel_runtime_state_t,
  tunnel_status_i
} from '@src/types/ssh_tunnel.types';
import type {
  ssh_client_constructor_t,
  ssh_client_i,
  ssh_connect_options_i,
  ssh_tcp_connection_details_t,
  ssh_unix_connection_details_t
} from '@src/types/runtime/ssh_runtime.types';
import type {
  ssh_tunnel_runtime_event_map_i,
  ssh_tunnel_runtime_event_name_t
} from '@src/types/ssh_tunnel_events.types';
import { ValidateTunnelDefinition } from '@src/validation/tunnel_definition.validator';

type remote_forward_binding_t =
  | {
      binding_type: 'tcp';
      remote_bind_address: string;
      remote_tcp_port: number;
    }
  | {
      binding_type: 'unix_socket';
      remote_socket_path: string;
    };

const MAX_UNIX_SOCKET_PATH_BYTES = 107;

function GetNormalizedReconnectStrategy(params: {
  tunnel_definition: tunnel_definition_t;
}): reconnect_strategy_t {
  const reconnect_strategy = params.tunnel_definition.reconnect_strategy;

  if (reconnect_strategy !== undefined) {
    return reconnect_strategy;
  }

  return {
    enabled: true,
    base_interval_ms: 1000,
    max_interval_ms: 30000,
    max_attempts: 'infinite',
    jitter_ratio: 0.2
  };
}

function GetErrorMessage(params: { error: unknown; fallback_message: string }): string {
  if (params.error instanceof Error) {
    return params.error.message;
  }

  return params.fallback_message;
}

function CalculateReconnectDelayMS(params: {
  attempt_number: number;
  reconnect_strategy: reconnect_strategy_t;
}): number {
  const exponential_delay =
    params.reconnect_strategy.base_interval_ms * 2 ** (params.attempt_number - 1);
  const bounded_delay = Math.min(
    exponential_delay,
    params.reconnect_strategy.max_interval_ms
  );

  if (params.reconnect_strategy.jitter_ratio <= 0) {
    return bounded_delay;
  }

  const jitter_window = bounded_delay * params.reconnect_strategy.jitter_ratio;
  const jitter_offset = (Math.random() * jitter_window * 2) - jitter_window;
  const jittered_delay = Math.max(1, Math.round(bounded_delay + jitter_offset));

  return jittered_delay;
}

function AreReconnectAttemptsExhausted(params: {
  reconnect_strategy: reconnect_strategy_t;
  attempt_count: number;
}): boolean {
  if (params.reconnect_strategy.max_attempts === 'infinite') {
    return false;
  }

  return params.attempt_count >= params.reconnect_strategy.max_attempts;
}

export function BuildSSHClientConnectOptions(params: {
  tunnel_definition: tunnel_definition_t;
}): ssh_connect_options_i {
  const auth = params.tunnel_definition.auth;
  const connect_options: ssh_connect_options_i = {
    host: params.tunnel_definition.host,
    port: params.tunnel_definition.port,
    username: auth.username
  };

  ApplyAuthenticationToConnectOptions({
    auth,
    connect_options
  });

  if (params.tunnel_definition.ready_timeout_ms !== undefined) {
    connect_options.readyTimeout = params.tunnel_definition.ready_timeout_ms;
  }

  if (params.tunnel_definition.keepalive_interval_ms !== undefined) {
    connect_options.keepaliveInterval = params.tunnel_definition.keepalive_interval_ms;
  }

  if (params.tunnel_definition.keepalive_count_max !== undefined) {
    connect_options.keepaliveCountMax = params.tunnel_definition.keepalive_count_max;
  }

  return connect_options;
}

function ApplyAuthenticationToConnectOptions(params: {
  auth: ssh_auth_t;
  connect_options: ssh_connect_options_i;
}): void {
  if ('password' in params.auth) {
    params.connect_options.password = params.auth.password;
    return;
  }

  params.connect_options.privateKey = params.auth.private_key;

  if (params.auth.passphrase !== undefined) {
    params.connect_options.passphrase = params.auth.passphrase;
  }
}

function ConvertLocalToRemoteEndpointMappingToLegacyPortMapping(params: {
  mapping: local_to_remote_endpoint_mapping_t;
}): local_to_remote_port_mapping_t | undefined {
  if (
    params.mapping.local_endpoint.endpoint_type !== 'tcp' ||
    params.mapping.remote_endpoint.endpoint_type !== 'tcp'
  ) {
    return undefined;
  }

  return {
    local_tcp_port: params.mapping.local_endpoint.tcp_port,
    remote_tcp_port: params.mapping.remote_endpoint.tcp_port,
    local_bind_address: params.mapping.local_endpoint.bind_address,
    remote_bind_address: params.mapping.remote_endpoint.bind_address
  };
}

function ConvertRemoteToLocalEndpointMappingToLegacyPortMapping(params: {
  mapping: remote_to_local_endpoint_mapping_t;
}): remote_to_local_port_mapping_t | undefined {
  if (
    params.mapping.remote_endpoint.endpoint_type !== 'tcp' ||
    params.mapping.local_endpoint.endpoint_type !== 'tcp'
  ) {
    return undefined;
  }

  return {
    remote_tcp_port: params.mapping.remote_endpoint.tcp_port,
    local_tcp_port: params.mapping.local_endpoint.tcp_port,
    remote_bind_address: params.mapping.remote_endpoint.bind_address,
    local_bind_address: params.mapping.local_endpoint.bind_address
  };
}

function CreateStreamLocalUnsupportedError(params: {
  method_name:
    | 'openssh_forwardOutStreamLocal'
    | 'openssh_forwardInStreamLocal'
    | 'openssh_unforwardInStreamLocal';
}): SSHTunnelError {
  return new SSHTunnelError({
    message: `SSH client does not support ${params.method_name}; streamlocal forwarding is unavailable.`,
    code: 'forwarding_error',
    context: {
      method_name: params.method_name
    }
  });
}

function GetEndpointDescription(params: { endpoint: tunnel_endpoint_t }): string {
  if (params.endpoint.endpoint_type === 'tcp') {
    const bind_address = params.endpoint.bind_address ?? '127.0.0.1';
    return `tcp://${bind_address}:${params.endpoint.tcp_port}`;
  }

  return `unix://${params.endpoint.socket_path}`;
}

function CreateLocalToRemoteForwardingError(params: {
  mapping: local_to_remote_endpoint_mapping_t;
  error: unknown;
}): SSHTunnelError {
  return new SSHTunnelError({
    message: `Failed to establish local-to-remote mapping ${GetEndpointDescription({
      endpoint: params.mapping.local_endpoint
    })} -> ${GetEndpointDescription({
      endpoint: params.mapping.remote_endpoint
    })}.`,
    code: 'forwarding_error',
    context: {
      direction: 'local_to_remote',
      local_endpoint: params.mapping.local_endpoint,
      remote_endpoint: params.mapping.remote_endpoint,
      error: params.error
    }
  });
}

function CreateRemoteToLocalForwardingError(params: {
  mapping: remote_to_local_endpoint_mapping_t;
  error: unknown;
}): SSHTunnelError {
  return new SSHTunnelError({
    message: `Failed to establish remote-to-local mapping ${GetEndpointDescription({
      endpoint: params.mapping.remote_endpoint
    })} -> ${GetEndpointDescription({
      endpoint: params.mapping.local_endpoint
    })}.`,
    code: 'forwarding_error',
    context: {
      direction: 'remote_to_local',
      remote_endpoint: params.mapping.remote_endpoint,
      local_endpoint: params.mapping.local_endpoint,
      error: params.error
    }
  });
}

export class SSHTunnelRuntime extends EventEmitter {
  private ssh_client_constructor: ssh_client_constructor_t | undefined;
  private readonly tunnel_definition: tunnel_definition_t;
  private readonly reconnect_strategy: reconnect_strategy_t;

  private ssh_client: ssh_client_i | undefined;
  private local_forward_servers: Server[];
  private local_unix_socket_paths: Set<string>;
  private remote_forward_bindings: remote_forward_binding_t[];
  private tcp_connection_listener_attached: boolean;
  private unix_connection_listener_attached: boolean;

  private state: tunnel_runtime_state_t;
  private last_error_message: string | undefined;
  private reconnect_attempt_count: number;
  private last_reconnect_attempt_at_iso_8601: string | undefined;
  private last_reconnect_delay_ms: number | undefined;
  private established_at_iso_8601: string | undefined;
  private disconnected_at_iso_8601: string | undefined;

  private connect_operation: Promise<tunnel_status_i> | undefined;
  private disconnect_operation: Promise<tunnel_status_i> | undefined;
  private reconnect_loop_running: boolean;
  private reconnect_loop_epoch: number;
  private manual_disconnect_requested: boolean;
  private cleanup_in_progress: boolean;

  constructor(params: {
    tunnel_definition: tunnel_definition_t;
    ssh_client_constructor?: ssh_client_constructor_t | undefined;
  }) {
    super();

    this.tunnel_definition = ValidateTunnelDefinition({
      tunnel_definition: params.tunnel_definition
    });
    this.reconnect_strategy = GetNormalizedReconnectStrategy({
      tunnel_definition: this.tunnel_definition
    });
    this.ssh_client_constructor = params.ssh_client_constructor;

    this.ssh_client = undefined;
    this.local_forward_servers = [];
    this.local_unix_socket_paths = new Set<string>();
    this.remote_forward_bindings = [];
    this.tcp_connection_listener_attached = false;
    this.unix_connection_listener_attached = false;

    this.state = 'defined';
    this.last_error_message = undefined;
    this.reconnect_attempt_count = 0;
    this.last_reconnect_attempt_at_iso_8601 = undefined;
    this.last_reconnect_delay_ms = undefined;
    this.established_at_iso_8601 = undefined;
    this.disconnected_at_iso_8601 = undefined;

    this.connect_operation = undefined;
    this.disconnect_operation = undefined;
    this.reconnect_loop_running = false;
    this.reconnect_loop_epoch = 0;
    this.manual_disconnect_requested = false;
    this.cleanup_in_progress = false;
  }

  on<EventName extends ssh_tunnel_runtime_event_name_t>(
    event_name: EventName,
    listener: (payload: ssh_tunnel_runtime_event_map_i[EventName]) => void
  ): this;
  on(event_name: string | symbol, listener: (...args: unknown[]) => void): this;
  on(event_name: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.on(event_name, listener);
  }

  once<EventName extends ssh_tunnel_runtime_event_name_t>(
    event_name: EventName,
    listener: (payload: ssh_tunnel_runtime_event_map_i[EventName]) => void
  ): this;
  once(event_name: string | symbol, listener: (...args: unknown[]) => void): this;
  once(event_name: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.once(event_name, listener);
  }

  off<EventName extends ssh_tunnel_runtime_event_name_t>(
    event_name: EventName,
    listener: (payload: ssh_tunnel_runtime_event_map_i[EventName]) => void
  ): this;
  off(event_name: string | symbol, listener: (...args: unknown[]) => void): this;
  off(event_name: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.off(event_name, listener);
  }

  async connect(): Promise<tunnel_status_i> {
    this.manual_disconnect_requested = false;

    if (this.connect_operation !== undefined) {
      return this.connect_operation;
    }

    const connect_operation = this.connectInternal({
      is_reconnect_attempt: false
    });

    this.connect_operation = connect_operation;

    try {
      const connected_status = await connect_operation;
      return connected_status;
    } finally {
      this.connect_operation = undefined;
    }
  }

  async disconnect(): Promise<tunnel_status_i> {
    this.manual_disconnect_requested = true;
    this.reconnect_loop_epoch += 1;

    if (this.disconnect_operation !== undefined) {
      return this.disconnect_operation;
    }

    const disconnect_operation = this.disconnectInternal();
    this.disconnect_operation = disconnect_operation;

    try {
      const disconnected_status = await disconnect_operation;
      return disconnected_status;
    } finally {
      this.disconnect_operation = undefined;
    }
  }

  getStatus(): tunnel_status_i {
    return {
      name: this.tunnel_definition.name,
      host: this.tunnel_definition.host,
      port: this.tunnel_definition.port,
      state: this.state,
      local_to_remote_port_mappings: this.tunnel_definition.local_to_remote_port_mappings,
      remote_to_local_port_mappings: this.tunnel_definition.remote_to_local_port_mappings,
      local_to_remote_endpoint_mappings:
        this.tunnel_definition.local_to_remote_endpoint_mappings ?? [],
      remote_to_local_endpoint_mappings:
        this.tunnel_definition.remote_to_local_endpoint_mappings ?? [],
      last_error_message: this.last_error_message,
      reconnect_attempt_count: this.reconnect_attempt_count,
      reconnect_info: {
        enabled: this.reconnect_strategy.enabled,
        base_interval_ms: this.reconnect_strategy.base_interval_ms,
        max_interval_ms: this.reconnect_strategy.max_interval_ms,
        max_attempts: this.reconnect_strategy.max_attempts,
        jitter_ratio: this.reconnect_strategy.jitter_ratio,
        attempt_count: this.reconnect_attempt_count,
        last_attempt_at_iso_8601: this.last_reconnect_attempt_at_iso_8601,
        last_scheduled_delay_ms: this.last_reconnect_delay_ms
      },
      established_at_iso_8601: this.established_at_iso_8601,
      disconnected_at_iso_8601: this.disconnected_at_iso_8601,
      updated_at_iso_8601: new Date().toISOString()
    };
  }

  private async connectInternal(params: {
    is_reconnect_attempt: boolean;
  }): Promise<tunnel_status_i> {
    if (!params.is_reconnect_attempt) {
      this.reconnect_attempt_count = 0;
      this.last_reconnect_attempt_at_iso_8601 = undefined;
      this.last_reconnect_delay_ms = undefined;
    }

    this.state = params.is_reconnect_attempt ? 'reconnecting' : 'connecting';
    this.last_error_message = undefined;
    this.disconnected_at_iso_8601 = undefined;

    await this.cleanupRuntimeResources();

    const ssh_client_constructor = await this.resolveSSHClientConstructor();
    const ssh_client = new ssh_client_constructor();
    this.ssh_client = ssh_client;

    try {
      this.bindLifecycleListeners({
        ssh_client
      });

      const connect_options = BuildSSHClientConnectOptions({
        tunnel_definition: this.tunnel_definition
      });

      await this.connectClient({
        ssh_client,
        connect_options
      });

      const local_to_remote_endpoint_mappings =
        this.tunnel_definition.local_to_remote_endpoint_mappings ?? [];
      const remote_to_local_endpoint_mappings =
        this.tunnel_definition.remote_to_local_endpoint_mappings ?? [];

      for (const mapping of local_to_remote_endpoint_mappings) {
        await this.establishLocalToRemoteEndpointForward({
          ssh_client,
          mapping
        });
      }

      for (const mapping of remote_to_local_endpoint_mappings) {
        await this.establishRemoteToLocalEndpointForward({
          ssh_client,
          mapping
        });
      }

      this.state = 'connected';
      this.established_at_iso_8601 = new Date().toISOString();
      const connected_status = this.getStatus();

      this.emitRuntimeEvent({
        event_name: 'connected',
        payload: {
          tunnel_name: this.tunnel_definition.name,
          status: connected_status
        }
      });

      return connected_status;
    } catch (error: unknown) {
      this.last_error_message = GetErrorMessage({
        error,
        fallback_message: 'Tunnel connection failed.'
      });

      await this.cleanupRuntimeResources();

      this.state = 'failed';

      if (error instanceof SSHTunnelError) {
        throw error;
      }

      throw new SSHTunnelError({
        message: `Failed to connect tunnel ${this.tunnel_definition.name}.`,
        code: 'connection_error',
        context: {
          tunnel_name: this.tunnel_definition.name,
          is_reconnect_attempt: params.is_reconnect_attempt,
          reconnect_attempt_count: this.reconnect_attempt_count,
          error
        }
      });
    }
  }

  private async disconnectInternal(): Promise<tunnel_status_i> {
    await this.cleanupRuntimeResources();

    this.state = 'disconnected';
    this.disconnected_at_iso_8601 = new Date().toISOString();
    const disconnected_status = this.getStatus();

    this.emitRuntimeEvent({
      event_name: 'disconnected',
      payload: {
        tunnel_name: this.tunnel_definition.name,
        status: disconnected_status,
        reason: 'manual_disconnect'
      }
    });

    return disconnected_status;
  }

  private bindLifecycleListeners(params: { ssh_client: ssh_client_i }): void {
    params.ssh_client.on('close', () => {
      this.handleRuntimeDisconnect({
        disconnected_client: params.ssh_client,
        disconnect_reason: 'close_event'
      });
    });

    params.ssh_client.on('end', () => {
      this.handleRuntimeDisconnect({
        disconnected_client: params.ssh_client,
        disconnect_reason: 'end_event'
      });
    });

    params.ssh_client.on('error', (error) => {
      if (this.ssh_client !== params.ssh_client) {
        return;
      }

      this.last_error_message = error.message;

      if (this.state === 'connecting' || this.state === 'connected') {
        this.state = 'failed';
      }
    });
  }

  private handleRuntimeDisconnect(params: {
    disconnected_client: ssh_client_i;
    disconnect_reason: string;
  }): void {
    if (this.ssh_client !== params.disconnected_client) {
      return;
    }

    this.disconnected_at_iso_8601 = new Date().toISOString();

    if (this.manual_disconnect_requested || this.cleanup_in_progress) {
      this.state = 'disconnected';
      return;
    }

    this.state = 'disconnected';
    this.last_error_message =
      this.last_error_message ??
      `Tunnel ${this.tunnel_definition.name} disconnected (${params.disconnect_reason}).`;

    this.emitRuntimeEvent({
      event_name: 'disconnected',
      payload: {
        tunnel_name: this.tunnel_definition.name,
        status: this.getStatus(),
        reason: params.disconnect_reason
      }
    });

    this.startReconnectLoopIfEligible();
  }

  private startReconnectLoopIfEligible(): void {
    if (!this.reconnect_strategy.enabled) {
      return;
    }

    if (this.reconnect_loop_running) {
      return;
    }

    if (this.manual_disconnect_requested) {
      return;
    }

    const reconnect_loop_epoch = this.reconnect_loop_epoch;
    this.reconnect_loop_running = true;

    void this.runReconnectLoop({
      reconnect_loop_epoch
    });
  }

  private async runReconnectLoop(params: {
    reconnect_loop_epoch: number;
  }): Promise<void> {
    let current_attempt_count = 0;

    try {
      while (true) {
        if (this.manual_disconnect_requested) {
          return;
        }

        if (params.reconnect_loop_epoch !== this.reconnect_loop_epoch) {
          return;
        }

        if (
          AreReconnectAttemptsExhausted({
            reconnect_strategy: this.reconnect_strategy,
            attempt_count: current_attempt_count
          })
        ) {
          this.state = 'failed';
          const exhausted_message =
            this.last_error_message ??
            `Reconnect attempts exhausted for tunnel ${this.tunnel_definition.name}.`;
          this.last_error_message = exhausted_message;

          this.emitRuntimeEvent({
            event_name: 'reconnect_failed',
            payload: {
              tunnel_name: this.tunnel_definition.name,
              attempt_count: current_attempt_count,
              error_message: exhausted_message,
              will_retry: false
            }
          });

          return;
        }

        current_attempt_count += 1;
        this.reconnect_attempt_count = current_attempt_count;
        this.state = 'reconnecting';

        const reconnect_delay_ms = CalculateReconnectDelayMS({
          attempt_number: current_attempt_count,
          reconnect_strategy: this.reconnect_strategy
        });
        this.last_reconnect_attempt_at_iso_8601 = new Date().toISOString();
        this.last_reconnect_delay_ms = reconnect_delay_ms;

        this.emitRuntimeEvent({
          event_name: 'reconnecting',
          payload: {
            tunnel_name: this.tunnel_definition.name,
            attempt_count: current_attempt_count,
            scheduled_delay_ms: reconnect_delay_ms
          }
        });

        await Delay(reconnect_delay_ms);

        if (this.manual_disconnect_requested) {
          return;
        }

        if (params.reconnect_loop_epoch !== this.reconnect_loop_epoch) {
          return;
        }

        try {
          await this.connectInternal({
            is_reconnect_attempt: true
          });

          return;
        } catch (error: unknown) {
          const reconnect_failure_message = GetErrorMessage({
            error,
            fallback_message: 'Reconnect attempt failed.'
          });

          this.last_error_message = reconnect_failure_message;

          this.emitRuntimeEvent({
            event_name: 'reconnect_failed',
            payload: {
              tunnel_name: this.tunnel_definition.name,
              attempt_count: current_attempt_count,
              error_message: reconnect_failure_message,
              will_retry: !AreReconnectAttemptsExhausted({
                reconnect_strategy: this.reconnect_strategy,
                attempt_count: current_attempt_count
              })
            }
          });
        }
      }
    } finally {
      this.reconnect_loop_running = false;
    }
  }

  private async resolveSSHClientConstructor(): Promise<ssh_client_constructor_t> {
    if (this.ssh_client_constructor !== undefined) {
      return this.ssh_client_constructor;
    }

    try {
      const ssh2_module_name = 'ssh2';
      const ssh2_module = (await import(ssh2_module_name)) as {
        Client?: ssh_client_constructor_t;
      };

      if (typeof ssh2_module.Client !== 'function') {
        throw new Error('ssh2.Client constructor not found.');
      }

      this.ssh_client_constructor = ssh2_module.Client;
      return this.ssh_client_constructor;
    } catch (error: unknown) {
      throw new SSHTunnelError({
        message:
          'ssh2 dependency is required for runtime tunneling. Install it with npm install ssh2.',
        code: 'dependency_missing',
        context: {
          dependency: 'ssh2',
          underlying_error: error
        }
      });
    }
  }

  private async connectClient(params: {
    ssh_client: ssh_client_i;
    connect_options: ssh_connect_options_i;
  }): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const on_ready = () => {
        if (settled) {
          return;
        }

        settled = true;
        resolve();
      };

      const on_error = (error: Error) => {
        if (settled) {
          return;
        }

        settled = true;
        reject(error);
      };

      params.ssh_client.once('ready', on_ready);
      params.ssh_client.once('error', on_error);

      params.ssh_client.connect(params.connect_options);
    });
  }

  private async establishLocalToRemoteEndpointForward(params: {
    ssh_client: ssh_client_i;
    mapping: local_to_remote_endpoint_mapping_t;
  }): Promise<void> {
    const legacy_mapping = ConvertLocalToRemoteEndpointMappingToLegacyPortMapping({
      mapping: params.mapping
    });

    try {
      await this.startLocalToRemoteEndpointForward({
        ssh_client: params.ssh_client,
        mapping: params.mapping
      });

      this.emitRuntimeEvent({
        event_name: 'forward_established',
        payload: {
          tunnel_name: this.tunnel_definition.name,
          direction: 'local_to_remote',
          endpoint_mapping: params.mapping,
          mapping: legacy_mapping
        }
      });
    } catch (error: unknown) {
      const forwarding_error = CreateLocalToRemoteForwardingError({
        mapping: params.mapping,
        error
      });

      this.emitRuntimeEvent({
        event_name: 'forward_failed',
        payload: {
          tunnel_name: this.tunnel_definition.name,
          direction: 'local_to_remote',
          endpoint_mapping: params.mapping,
          mapping: legacy_mapping,
          error_message: forwarding_error.message
        }
      });

      throw forwarding_error;
    }
  }

  private async establishRemoteToLocalEndpointForward(params: {
    ssh_client: ssh_client_i;
    mapping: remote_to_local_endpoint_mapping_t;
  }): Promise<void> {
    const legacy_mapping = ConvertRemoteToLocalEndpointMappingToLegacyPortMapping({
      mapping: params.mapping
    });

    try {
      await this.startRemoteToLocalEndpointForward({
        ssh_client: params.ssh_client,
        mapping: params.mapping
      });

      this.emitRuntimeEvent({
        event_name: 'forward_established',
        payload: {
          tunnel_name: this.tunnel_definition.name,
          direction: 'remote_to_local',
          endpoint_mapping: params.mapping,
          mapping: legacy_mapping
        }
      });
    } catch (error: unknown) {
      const forwarding_error = CreateRemoteToLocalForwardingError({
        mapping: params.mapping,
        error
      });

      this.emitRuntimeEvent({
        event_name: 'forward_failed',
        payload: {
          tunnel_name: this.tunnel_definition.name,
          direction: 'remote_to_local',
          endpoint_mapping: params.mapping,
          mapping: legacy_mapping,
          error_message: forwarding_error.message
        }
      });

      throw forwarding_error;
    }
  }

  private async startLocalToRemoteEndpointForward(params: {
    ssh_client: ssh_client_i;
    mapping: local_to_remote_endpoint_mapping_t;
  }): Promise<void> {
    if (params.mapping.remote_endpoint.endpoint_type === 'unix_socket') {
      if (params.ssh_client.openssh_forwardOutStreamLocal === undefined) {
        throw CreateStreamLocalUnsupportedError({
          method_name: 'openssh_forwardOutStreamLocal'
        });
      }
    }

    if (params.mapping.local_endpoint.endpoint_type === 'unix_socket') {
      await this.prepareLocalUnixSocketPathForListen({
        socket_path: params.mapping.local_endpoint.socket_path
      });
    }

    const server = createServer((local_socket) => {
      this.handleLocalSocketConnection({
        ssh_client: params.ssh_client,
        local_socket,
        mapping: params.mapping
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', (error) => {
        if (params.mapping.local_endpoint.endpoint_type !== 'unix_socket') {
          reject(error);
          return;
        }

        reject(
          new SSHTunnelError({
            message: `Failed to listen on UNIX socket path ${params.mapping.local_endpoint.socket_path}.`,
            code: 'forwarding_error',
            context: {
              socket_path: params.mapping.local_endpoint.socket_path,
              error
            }
          })
        );
      });

      if (params.mapping.local_endpoint.endpoint_type === 'tcp') {
        const local_bind_address = params.mapping.local_endpoint.bind_address ?? '127.0.0.1';
        server.listen(params.mapping.local_endpoint.tcp_port, local_bind_address, () => {
          resolve();
        });
        return;
      }

      server.listen(params.mapping.local_endpoint.socket_path, () => {
        resolve();
      });
    });

    this.local_forward_servers.push(server);

    if (params.mapping.local_endpoint.endpoint_type === 'unix_socket') {
      this.local_unix_socket_paths.add(params.mapping.local_endpoint.socket_path);
    }
  }

  private handleLocalSocketConnection(params: {
    ssh_client: ssh_client_i;
    local_socket: Socket;
    mapping: local_to_remote_endpoint_mapping_t;
  }): void {
    const source_ip = params.local_socket.remoteAddress ?? '127.0.0.1';
    const source_port = params.local_socket.remotePort ?? 0;

    if (params.mapping.remote_endpoint.endpoint_type === 'tcp') {
      const remote_bind_address = params.mapping.remote_endpoint.bind_address ?? '127.0.0.1';

      params.ssh_client.forwardOut(
        source_ip,
        source_port,
        remote_bind_address,
        params.mapping.remote_endpoint.tcp_port,
        (error, stream) => {
          if (error !== undefined || stream === undefined) {
            params.local_socket.destroy(error);
            return;
          }

          params.local_socket.on('error', () => {
            stream.destroy();
          });

          stream.on('error', () => {
            params.local_socket.destroy();
          });

          params.local_socket.pipe(stream);
          stream.pipe(params.local_socket);
        }
      );

      return;
    }

    if (params.ssh_client.openssh_forwardOutStreamLocal === undefined) {
      params.local_socket.destroy(
        CreateStreamLocalUnsupportedError({
          method_name: 'openssh_forwardOutStreamLocal'
        })
      );
      return;
    }

    params.ssh_client.openssh_forwardOutStreamLocal(
      params.mapping.remote_endpoint.socket_path,
      (error, stream) => {
        if (error !== undefined || stream === undefined) {
          params.local_socket.destroy(error);
          return;
        }

        params.local_socket.on('error', () => {
          stream.destroy();
        });

        stream.on('error', () => {
          params.local_socket.destroy();
        });

        params.local_socket.pipe(stream);
        stream.pipe(params.local_socket);
      }
    );
  }

  private async startRemoteToLocalEndpointForward(params: {
    ssh_client: ssh_client_i;
    mapping: remote_to_local_endpoint_mapping_t;
  }): Promise<void> {
    if (params.mapping.remote_endpoint.endpoint_type === 'tcp') {
      const remote_endpoint = params.mapping.remote_endpoint;

      if (!this.tcp_connection_listener_attached) {
        this.attachTCPConnectionListener({
          ssh_client: params.ssh_client
        });
        this.tcp_connection_listener_attached = true;
      }

      const remote_bind_address = remote_endpoint.bind_address ?? '127.0.0.1';

      await new Promise<void>((resolve, reject) => {
        params.ssh_client.forwardIn(
          remote_bind_address,
          remote_endpoint.tcp_port,
          (error) => {
            if (error !== undefined) {
              reject(error);
              return;
            }

            resolve();
          }
        );
      });

      this.remote_forward_bindings.push({
        binding_type: 'tcp',
        remote_bind_address,
        remote_tcp_port: remote_endpoint.tcp_port
      });

      return;
    }

    const remote_endpoint = params.mapping.remote_endpoint;

    if (!this.unix_connection_listener_attached) {
      this.attachUNIXConnectionListener({
        ssh_client: params.ssh_client
      });
      this.unix_connection_listener_attached = true;
    }

    if (params.ssh_client.openssh_forwardInStreamLocal === undefined) {
      throw CreateStreamLocalUnsupportedError({
        method_name: 'openssh_forwardInStreamLocal'
      });
    }

    await new Promise<void>((resolve, reject) => {
      params.ssh_client.openssh_forwardInStreamLocal!(
        remote_endpoint.socket_path,
        (error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }

          resolve();
        }
      );
    });

    this.remote_forward_bindings.push({
      binding_type: 'unix_socket',
      remote_socket_path: remote_endpoint.socket_path
    });
  }

  private attachTCPConnectionListener(params: {
    ssh_client: ssh_client_i;
  }): void {
    params.ssh_client.on('tcp connection', (details, accept, reject) => {
      const mapping = this.findRemoteToLocalEndpointMappingByTCPDetails({
        details
      });

      if (mapping === undefined) {
        reject();
        return;
      }

      const stream = accept();
      const local_socket = this.createLocalSocketForEndpoint({
        endpoint: mapping.local_endpoint
      });

      local_socket.on('error', () => {
        stream.end();
      });

      stream.on('error', () => {
        local_socket.destroy();
      });

      stream.pipe(local_socket);
      local_socket.pipe(stream);
    });
  }

  private attachUNIXConnectionListener(params: {
    ssh_client: ssh_client_i;
  }): void {
    params.ssh_client.on('unix connection', (details, accept, reject) => {
      const remote_socket_path = this.getRemoteSocketPathFromUnixDetails({
        details
      });

      if (remote_socket_path === undefined) {
        reject();
        return;
      }

      const mapping = this.findRemoteToLocalEndpointMappingByUNIXSocketPath({
        remote_socket_path
      });

      if (mapping === undefined) {
        reject();
        return;
      }

      const stream = accept();
      const local_socket = this.createLocalSocketForEndpoint({
        endpoint: mapping.local_endpoint
      });

      local_socket.on('error', () => {
        stream.end();
      });

      stream.on('error', () => {
        local_socket.destroy();
      });

      stream.pipe(local_socket);
      local_socket.pipe(stream);
    });
  }

  private createLocalSocketForEndpoint(params: {
    endpoint: tunnel_endpoint_t;
  }): Socket {
    if (params.endpoint.endpoint_type === 'tcp') {
      const local_bind_address = params.endpoint.bind_address ?? '127.0.0.1';
      return connect({
        host: local_bind_address,
        port: params.endpoint.tcp_port
      });
    }

    return connect(params.endpoint.socket_path);
  }

  private getRemoteSocketPathFromUnixDetails(params: {
    details: ssh_unix_connection_details_t;
  }): string | undefined {
    return (
      params.details.socket_path ??
      params.details.socketPath ??
      params.details.path
    );
  }

  private findRemoteToLocalEndpointMappingByTCPDetails(params: {
    details: ssh_tcp_connection_details_t;
  }): remote_to_local_endpoint_mapping_t | undefined {
    const endpoint_mappings =
      this.tunnel_definition.remote_to_local_endpoint_mappings ?? [];

    return endpoint_mappings.find((mapping) => {
      if (mapping.remote_endpoint.endpoint_type !== 'tcp') {
        return false;
      }

      const mapping_bind_address = mapping.remote_endpoint.bind_address ?? '127.0.0.1';
      const destination_address = params.details.destIP;
      const bind_address_matches =
        mapping_bind_address === destination_address ||
        destination_address === '0.0.0.0' ||
        destination_address === '::';

      return bind_address_matches && params.details.destPort === mapping.remote_endpoint.tcp_port;
    });
  }

  private findRemoteToLocalEndpointMappingByUNIXSocketPath(params: {
    remote_socket_path: string;
  }): remote_to_local_endpoint_mapping_t | undefined {
    const endpoint_mappings =
      this.tunnel_definition.remote_to_local_endpoint_mappings ?? [];

    return endpoint_mappings.find((mapping) => {
      if (mapping.remote_endpoint.endpoint_type !== 'unix_socket') {
        return false;
      }

      return mapping.remote_endpoint.socket_path === params.remote_socket_path;
    });
  }

  private async prepareLocalUnixSocketPathForListen(params: {
    socket_path: string;
  }): Promise<void> {
    this.validateLocalUnixSocketPathLength({
      socket_path: params.socket_path
    });

    await this.ensureLocalUnixSocketParentDirectory({
      socket_path: params.socket_path
    });

    await this.removeExistingLocalUnixSocketPath({
      socket_path: params.socket_path
    });
  }

  private validateLocalUnixSocketPathLength(params: { socket_path: string }): void {
    const socket_path_byte_length = Buffer.byteLength(params.socket_path);

    if (socket_path_byte_length <= MAX_UNIX_SOCKET_PATH_BYTES) {
      return;
    }

    throw new SSHTunnelError({
      message: `UNIX socket path exceeds platform limits: ${params.socket_path}.`,
      code: 'forwarding_error',
      context: {
        socket_path: params.socket_path,
        socket_path_byte_length,
        max_socket_path_bytes: MAX_UNIX_SOCKET_PATH_BYTES
      }
    });
  }

  private async ensureLocalUnixSocketParentDirectory(params: {
    socket_path: string;
  }): Promise<void> {
    const socket_parent_directory_path = dirname(params.socket_path);

    let parent_directory_stat: Awaited<ReturnType<typeof stat>>;

    try {
      parent_directory_stat = await stat(socket_parent_directory_path);
    } catch (error: unknown) {
      throw new SSHTunnelError({
        message: `UNIX socket directory does not exist: ${socket_parent_directory_path}.`,
        code: 'forwarding_error',
        context: {
          socket_path: params.socket_path,
          socket_parent_directory_path,
          error
        }
      });
    }

    if (parent_directory_stat.isDirectory()) {
      return;
    }

    throw new SSHTunnelError({
      message: `UNIX socket directory path is not a directory: ${socket_parent_directory_path}.`,
      code: 'forwarding_error',
      context: {
        socket_path: params.socket_path,
        socket_parent_directory_path
      }
    });
  }

  private async removeExistingLocalUnixSocketPath(params: {
    socket_path: string;
  }): Promise<void> {
    try {
      const socket_path_stat = await lstat(params.socket_path);

      if (!socket_path_stat.isSocket()) {
        throw new SSHTunnelError({
          message: `UNIX socket path already exists and is not a socket: ${params.socket_path}.`,
          code: 'forwarding_error',
          context: {
            socket_path: params.socket_path
          }
        });
      }

      await unlink(params.socket_path);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }

      if (error instanceof SSHTunnelError) {
        throw error;
      }

      throw new SSHTunnelError({
        message: `Failed to prepare UNIX socket path for listening: ${params.socket_path}.`,
        code: 'forwarding_error',
        context: {
          socket_path: params.socket_path,
          error
        }
      });
    }
  }

  private async removeManagedLocalUnixSocketPaths(): Promise<void> {
    const socket_paths = [...this.local_unix_socket_paths.values()];
    this.local_unix_socket_paths.clear();

    for (const socket_path of socket_paths) {
      try {
        await unlink(socket_path);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          continue;
        }

        this.last_error_message = GetErrorMessage({
          error,
          fallback_message: `Failed to remove UNIX socket path ${socket_path}.`
        });
      }
    }
  }

  private emitRuntimeEvent<EventName extends ssh_tunnel_runtime_event_name_t>(params: {
    event_name: EventName;
    payload: ssh_tunnel_runtime_event_map_i[EventName];
  }): void {
    super.emit(params.event_name, params.payload);
  }

  private async cleanupRuntimeResources(): Promise<void> {
    this.cleanup_in_progress = true;

    try {
      await this.closeLocalForwardServers();
      await this.closeRemoteToLocalForwards();
      await this.endClient();
    } finally {
      this.cleanup_in_progress = false;
    }
  }

  private async closeLocalForwardServers(): Promise<void> {
    const close_server_promises = this.local_forward_servers.map(async (server) => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    });

    await Promise.all(close_server_promises);
    this.local_forward_servers = [];
    await this.removeManagedLocalUnixSocketPaths();
  }

  private async closeRemoteToLocalForwards(): Promise<void> {
    const ssh_client = this.ssh_client;

    if (ssh_client === undefined) {
      this.remote_forward_bindings = [];
      return;
    }

    const close_remote_forward_promises = this.remote_forward_bindings.map(
      async (binding) => {
        if (binding.binding_type === 'unix_socket') {
          if (ssh_client.openssh_unforwardInStreamLocal === undefined) {
            return;
          }

          await Promise.race([
            new Promise<void>((resolve) => {
              ssh_client.openssh_unforwardInStreamLocal!(
                binding.remote_socket_path,
                () => {
                  resolve();
                }
              );
            }),
            Delay(250)
          ]);

          return;
        }

        await Promise.race([
          new Promise<void>((resolve) => {
            ssh_client.unforwardIn(
              binding.remote_bind_address,
              binding.remote_tcp_port,
              () => {
                resolve();
              }
            );
          }),
          Delay(250)
        ]);
      }
    );

    await Promise.all(close_remote_forward_promises);
    this.remote_forward_bindings = [];
  }

  private async endClient(): Promise<void> {
    const ssh_client = this.ssh_client;

    if (ssh_client === undefined) {
      return;
    }

    const close_waiter = new Promise<void>((resolve) => {
      ssh_client.once('close', () => {
        resolve();
      });

      ssh_client.end();
    });

    await Promise.race([close_waiter, Delay(250)]);

    ssh_client.removeAllListeners();

    if (this.ssh_client === ssh_client) {
      this.ssh_client = undefined;
    }

    this.tcp_connection_listener_attached = false;
    this.unix_connection_listener_attached = false;
  }
}
