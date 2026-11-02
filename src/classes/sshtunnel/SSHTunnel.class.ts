import { EventEmitter } from 'node:events';

import { SSHTunnelRuntime } from '@src/classes/ssh_tunnel_runtime/SSHTunnelRuntime.class';
import { SSHTunnelError } from '@src/errors/SSHTunnelError.class';
import type {
  ssh_tunnel_runtime_event_map_i,
  ssh_tunnel_runtime_event_name_t
} from '@src/types/ssh_tunnel_events.types';
import type {
  ssh_tunnel_manager_dependencies_i,
  tunnel_runtime_factory_t,
  tunnel_runtime_i
} from '@src/types/ssh_tunnel_manager.types';
import type {
  tunnel_definition_input_t,
  tunnel_definition_t,
  tunnel_establishment_failure_i,
  tunnel_establishment_summary_i,
  tunnel_status_i
} from '@src/types/ssh_tunnel.types';
import {
  ValidateTunnelDefinition,
  ValidateTunnelDefinitions
} from '@src/validation/tunnel_definition.validator';

type observable_tunnel_runtime_t = tunnel_runtime_i & {
  on: <EventName extends ssh_tunnel_runtime_event_name_t>(
    event_name: EventName,
    listener: (payload: ssh_tunnel_runtime_event_map_i[EventName]) => void
  ) => void;
};

function CreateDefaultTunnelRuntimeFactory(): tunnel_runtime_factory_t {
  return function BuildRuntime(params: {
    tunnel_definition: tunnel_definition_t;
  }): tunnel_runtime_i {
    return new SSHTunnelRuntime({
      tunnel_definition: params.tunnel_definition
    });
  };
}

function CreateTunnelNotFoundError(params: {
  tunnel_name: string;
}): SSHTunnelError {
  return new SSHTunnelError({
    message: `Tunnel ${params.tunnel_name} was not found.`,
    code: 'tunnel_not_found',
    context: {
      tunnel_name: params.tunnel_name
    }
  });
}

export class SSHTunnel extends EventEmitter {
  private readonly tunnel_runtime_factory: tunnel_runtime_factory_t;
  private readonly tunnel_definitions_by_name: Map<string, tunnel_definition_t>;
  private readonly tunnel_runtimes_by_name: Map<string, tunnel_runtime_i>;
  private readonly tunnel_status_by_name: Map<string, tunnel_status_i>;
  private readonly runtime_event_bridge_by_name: Set<string>;

  constructor(params?: ssh_tunnel_manager_dependencies_i) {
    super();

    this.tunnel_runtime_factory =
      params?.tunnel_runtime_factory ?? CreateDefaultTunnelRuntimeFactory();
    this.tunnel_definitions_by_name = new Map<string, tunnel_definition_t>();
    this.tunnel_runtimes_by_name = new Map<string, tunnel_runtime_i>();
    this.tunnel_status_by_name = new Map<string, tunnel_status_i>();
    this.runtime_event_bridge_by_name = new Set<string>();
  }

  on<EventName extends ssh_tunnel_runtime_event_name_t>(
    event_name: EventName,
    listener: (payload: ssh_tunnel_runtime_event_map_i[EventName]) => void
  ): this;
  on(event_name: string | symbol, listener: (...args: unknown[]) => void): this;
  on(
    event_name: string | symbol,
    listener: (...args: unknown[]) => void
  ): this {
    return super.on(event_name, listener);
  }

  once<EventName extends ssh_tunnel_runtime_event_name_t>(
    event_name: EventName,
    listener: (payload: ssh_tunnel_runtime_event_map_i[EventName]) => void
  ): this;
  once(
    event_name: string | symbol,
    listener: (...args: unknown[]) => void
  ): this;
  once(
    event_name: string | symbol,
    listener: (...args: unknown[]) => void
  ): this {
    return super.once(event_name, listener);
  }

  off<EventName extends ssh_tunnel_runtime_event_name_t>(
    event_name: EventName,
    listener: (payload: ssh_tunnel_runtime_event_map_i[EventName]) => void
  ): this;
  off(
    event_name: string | symbol,
    listener: (...args: unknown[]) => void
  ): this;
  off(
    event_name: string | symbol,
    listener: (...args: unknown[]) => void
  ): this {
    return super.off(event_name, listener);
  }

  defineTunnel(params: tunnel_definition_input_t): void {
    const validated_definition = ValidateTunnelDefinition({
      tunnel_definition: params
    });

    const candidate_definitions = [
      ...this.tunnel_definitions_by_name.values(),
      validated_definition
    ];

    ValidateTunnelDefinitions({
      tunnel_definitions: candidate_definitions
    });

    this.tunnel_definitions_by_name.set(
      validated_definition.name,
      validated_definition
    );
    this.tunnel_status_by_name.set(
      validated_definition.name,
      this.createDefinedStatus({
        tunnel_definition: validated_definition
      })
    );
  }

  async establishTunnels(): Promise<tunnel_establishment_summary_i> {
    const started_at_iso_8601 = new Date().toISOString();
    const established_tunnels: string[] = [];
    const failed_tunnels: tunnel_establishment_failure_i[] = [];
    const skipped_tunnels: string[] = [];

    for (const tunnel_name of this.tunnel_definitions_by_name.keys()) {
      const existing_status = this.getCurrentTunnelStatusByName({
        name: tunnel_name
      });

      if (existing_status.state === 'connected') {
        skipped_tunnels.push(tunnel_name);
        continue;
      }

      try {
        const started_status = await this.startTunnel({
          name: tunnel_name
        });

        if (started_status.state === 'connected') {
          established_tunnels.push(tunnel_name);
          continue;
        }

        failed_tunnels.push({
          name: tunnel_name,
          error_code: 'connection_error',
          error_message:
            started_status.last_error_message ?? 'Connection failed.'
        });
      } catch (error: unknown) {
        failed_tunnels.push(
          this.createEstablishmentFailureInfo({
            tunnel_name,
            error
          })
        );
      }
    }

    return {
      established_tunnels,
      failed_tunnels,
      skipped_tunnels,
      started_at_iso_8601,
      completed_at_iso_8601: new Date().toISOString()
    };
  }

  async tunnelStatus(): Promise<tunnel_status_i[]> {
    const tunnel_statuses: tunnel_status_i[] = [];

    for (const tunnel_name of this.tunnel_definitions_by_name.keys()) {
      tunnel_statuses.push(
        this.getCurrentTunnelStatusByName({
          name: tunnel_name
        })
      );
    }

    return tunnel_statuses;
  }

  async startTunnel(params: { name: string }): Promise<tunnel_status_i> {
    const tunnel_definition = this.getTunnelDefinitionByName({
      name: params.name
    });

    const tunnel_runtime = this.getOrCreateRuntimeByName({
      tunnel_definition
    });

    try {
      const tunnel_status = await tunnel_runtime.connect();
      this.tunnel_status_by_name.set(params.name, tunnel_status);
      return tunnel_status;
    } catch (error: unknown) {
      const failed_status = this.createFailedStatus({
        tunnel_definition,
        error
      });
      this.tunnel_status_by_name.set(params.name, failed_status);
      throw error;
    }
  }

  async stopTunnel(params: { name: string }): Promise<tunnel_status_i> {
    const tunnel_definition = this.getTunnelDefinitionByName({
      name: params.name
    });

    const tunnel_runtime = this.tunnel_runtimes_by_name.get(params.name);

    if (tunnel_runtime === undefined) {
      const stopped_status = this.createDisconnectedStatus({
        tunnel_definition
      });
      this.tunnel_status_by_name.set(params.name, stopped_status);
      return stopped_status;
    }

    const stopped_status = await tunnel_runtime.disconnect();
    this.tunnel_status_by_name.set(params.name, stopped_status);
    return stopped_status;
  }

  async restartTunnel(params: { name: string }): Promise<tunnel_status_i> {
    await this.stopTunnel({
      name: params.name
    });

    const restarted_status = await this.startTunnel({
      name: params.name
    });

    return restarted_status;
  }

  async stopAllTunnels(): Promise<tunnel_status_i[]> {
    const stopped_statuses: tunnel_status_i[] = [];

    for (const tunnel_name of this.tunnel_definitions_by_name.keys()) {
      const stopped_status = await this.stopTunnel({
        name: tunnel_name
      });

      stopped_statuses.push(stopped_status);
    }

    return stopped_statuses;
  }

  async removeTunnel(params: { name: string }): Promise<void> {
    const tunnel_exists = this.tunnel_definitions_by_name.has(params.name);

    if (!tunnel_exists) {
      throw CreateTunnelNotFoundError({
        tunnel_name: params.name
      });
    }

    const existing_runtime = this.tunnel_runtimes_by_name.get(params.name);

    if (existing_runtime !== undefined) {
      await existing_runtime.disconnect();
    }

    this.tunnel_runtimes_by_name.delete(params.name);
    this.tunnel_definitions_by_name.delete(params.name);
    this.tunnel_status_by_name.delete(params.name);
    this.runtime_event_bridge_by_name.delete(params.name);
  }

  private getCurrentTunnelStatusByName(params: {
    name: string;
  }): tunnel_status_i {
    const tunnel_runtime = this.tunnel_runtimes_by_name.get(params.name);

    if (tunnel_runtime !== undefined) {
      const runtime_status = tunnel_runtime.getStatus();
      this.tunnel_status_by_name.set(params.name, runtime_status);
      return runtime_status;
    }

    const known_status = this.tunnel_status_by_name.get(params.name);

    if (known_status !== undefined) {
      return {
        ...known_status,
        updated_at_iso_8601: new Date().toISOString()
      };
    }

    const tunnel_definition = this.getTunnelDefinitionByName({
      name: params.name
    });

    const default_status = this.createDefinedStatus({
      tunnel_definition
    });
    this.tunnel_status_by_name.set(params.name, default_status);
    return default_status;
  }

  private getOrCreateRuntimeByName(params: {
    tunnel_definition: tunnel_definition_t;
  }): tunnel_runtime_i {
    const existing_runtime = this.tunnel_runtimes_by_name.get(
      params.tunnel_definition.name
    );

    if (existing_runtime !== undefined) {
      return existing_runtime;
    }

    const created_runtime = this.tunnel_runtime_factory({
      tunnel_definition: params.tunnel_definition
    });

    this.tunnel_runtimes_by_name.set(
      params.tunnel_definition.name,
      created_runtime
    );
    this.bindRuntimeEvents({
      tunnel_name: params.tunnel_definition.name,
      runtime: created_runtime
    });

    return created_runtime;
  }

  private bindRuntimeEvents(params: {
    tunnel_name: string;
    runtime: tunnel_runtime_i;
  }): void {
    if (this.runtime_event_bridge_by_name.has(params.tunnel_name)) {
      return;
    }

    const observable_runtime = this.getObservableRuntime({
      runtime: params.runtime
    });

    if (observable_runtime === undefined) {
      return;
    }

    this.runtime_event_bridge_by_name.add(params.tunnel_name);

    const event_names: ssh_tunnel_runtime_event_name_t[] = [
      'connected',
      'disconnected',
      'reconnecting',
      'reconnect_failed',
      'forward_established',
      'forward_failed'
    ];

    for (const event_name of event_names) {
      observable_runtime.on(event_name, (event_payload) => {
        this.emit(event_name, event_payload);
      });
    }
  }

  private getObservableRuntime(params: {
    runtime: tunnel_runtime_i;
  }): observable_tunnel_runtime_t | undefined {
    if (typeof (params.runtime as { on?: unknown }).on !== 'function') {
      return undefined;
    }

    return params.runtime as observable_tunnel_runtime_t;
  }

  private getTunnelDefinitionByName(params: {
    name: string;
  }): tunnel_definition_t {
    const tunnel_definition = this.tunnel_definitions_by_name.get(params.name);

    if (tunnel_definition === undefined) {
      throw CreateTunnelNotFoundError({
        tunnel_name: params.name
      });
    }

    return tunnel_definition;
  }

  private createEstablishmentFailureInfo(params: {
    tunnel_name: string;
    error: unknown;
  }): tunnel_establishment_failure_i {
    if (params.error instanceof SSHTunnelError) {
      return {
        name: params.tunnel_name,
        error_code: params.error.code,
        error_message: params.error.message
      };
    }

    return {
      name: params.tunnel_name,
      error_code: 'internal_error',
      error_message:
        params.error instanceof Error
          ? params.error.message
          : 'Unexpected establishment failure.'
    };
  }

  private createDefinedStatus(params: {
    tunnel_definition: tunnel_definition_t;
  }): tunnel_status_i {
    const reconnect_strategy = params.tunnel_definition.reconnect_strategy;

    return {
      name: params.tunnel_definition.name,
      host: params.tunnel_definition.host,
      port: params.tunnel_definition.port,
      state: 'defined',
      local_to_remote_port_mappings:
        params.tunnel_definition.local_to_remote_port_mappings,
      remote_to_local_port_mappings:
        params.tunnel_definition.remote_to_local_port_mappings,
      local_to_remote_endpoint_mappings:
        params.tunnel_definition.local_to_remote_endpoint_mappings ?? [],
      remote_to_local_endpoint_mappings:
        params.tunnel_definition.remote_to_local_endpoint_mappings ?? [],
      reconnect_attempt_count: 0,
      reconnect_info: {
        enabled: reconnect_strategy?.enabled ?? true,
        base_interval_ms: reconnect_strategy?.base_interval_ms ?? 1000,
        max_interval_ms: reconnect_strategy?.max_interval_ms ?? 30000,
        max_attempts: reconnect_strategy?.max_attempts ?? 'infinite',
        jitter_ratio: reconnect_strategy?.jitter_ratio ?? 0.2,
        attempt_count: 0
      },
      updated_at_iso_8601: new Date().toISOString()
    };
  }

  private createDisconnectedStatus(params: {
    tunnel_definition: tunnel_definition_t;
  }): tunnel_status_i {
    return {
      ...this.createDefinedStatus({
        tunnel_definition: params.tunnel_definition
      }),
      state: 'disconnected',
      disconnected_at_iso_8601: new Date().toISOString()
    };
  }

  private createFailedStatus(params: {
    tunnel_definition: tunnel_definition_t;
    error: unknown;
  }): tunnel_status_i {
    const error_message =
      params.error instanceof Error
        ? params.error.message
        : 'Unexpected tunnel runtime failure.';

    return {
      ...this.createDefinedStatus({
        tunnel_definition: params.tunnel_definition
      }),
      state: 'failed',
      last_error_message: error_message
    };
  }
}
