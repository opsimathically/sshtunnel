import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { setTimeout as Delay } from 'node:timers/promises';
import test from 'node:test';
import { PassThrough } from 'node:stream';

import {
  SSHTunnel,
  SSHTunnelRuntime,
  type ssh_client_i,
  type ssh_connect_options_i,
  type ssh_tunnel_runtime_event_map_i,
  type tunnel_definition_t,
  type tunnel_runtime_factory_t,
  type tunnel_runtime_i,
  type tunnel_status_i
} from '@src/index';

type observability_fake_config_t = {
  close_after_ready_connect_attempts: Set<number>;
  connect_error_attempts: Set<number>;
  forward_in_error_attempts: Set<number>;
};

class ObservabilityFakeSSHClient extends EventEmitter implements ssh_client_i {
  static connect_attempt_count = 0;
  static config: observability_fake_config_t = {
    close_after_ready_connect_attempts: new Set<number>(),
    connect_error_attempts: new Set<number>(),
    forward_in_error_attempts: new Set<number>()
  };

  private current_connect_attempt_number: number;

  constructor() {
    super();
    this.current_connect_attempt_number = 0;
  }

  static Reset(params?: {
    close_after_ready_connect_attempts?: number[];
    connect_error_attempts?: number[];
    forward_in_error_attempts?: number[];
  }): void {
    ObservabilityFakeSSHClient.connect_attempt_count = 0;
    ObservabilityFakeSSHClient.config = {
      close_after_ready_connect_attempts: new Set(
        params?.close_after_ready_connect_attempts ?? []
      ),
      connect_error_attempts: new Set(params?.connect_error_attempts ?? []),
      forward_in_error_attempts: new Set(params?.forward_in_error_attempts ?? [])
    };
  }

  connect(params: ssh_connect_options_i): void {
    void params;

    ObservabilityFakeSSHClient.connect_attempt_count += 1;
    this.current_connect_attempt_number = ObservabilityFakeSSHClient.connect_attempt_count;

    if (
      ObservabilityFakeSSHClient.config.connect_error_attempts.has(
        this.current_connect_attempt_number
      )
    ) {
      process.nextTick(() => {
        this.emit(
          'error',
          new Error(`Connect failure ${this.current_connect_attempt_number}`)
        );
        this.emit('close', true);
      });

      return;
    }

    process.nextTick(() => {
      this.emit('ready');

      if (
        ObservabilityFakeSSHClient.config.close_after_ready_connect_attempts.has(
          this.current_connect_attempt_number
        )
      ) {
        setTimeout(() => {
          this.emit('close', true);
        }, 5);
      }
    });
  }

  end(): void {
    process.nextTick(() => {
      this.emit('close', false);
    });
  }

  forwardOut(
    src_ip: string,
    src_port: number,
    dst_ip: string,
    dst_port: number,
    callback: (error: Error | undefined, stream: PassThrough | undefined) => void
  ): void {
    void src_ip;
    void src_port;
    void dst_ip;
    void dst_port;

    callback(undefined, new PassThrough());
  }

  forwardIn(
    bind_address: string,
    bind_port: number,
    callback: (error?: Error | undefined) => void
  ): void {
    void bind_address;
    void bind_port;

    if (
      ObservabilityFakeSSHClient.config.forward_in_error_attempts.has(
        this.current_connect_attempt_number
      )
    ) {
      callback(new Error(`forwardIn failure ${this.current_connect_attempt_number}`));
      return;
    }

    callback(undefined);
  }

  unforwardIn(
    bind_address: string,
    bind_port: number,
    callback: (error?: Error | undefined) => void
  ): void {
    void bind_address;
    void bind_port;
    callback(undefined);
  }

  removeAllListeners(event_name?: string | symbol): this {
    return super.removeAllListeners(event_name);
  }
}

function CreateEventTunnelDefinition(params: {
  name: string;
  max_attempts: number | 'infinite';
}): tunnel_definition_t {
  return {
    name: params.name,
    host: '127.0.0.1',
    port: 22,
    local_to_remote_port_mappings: [],
    remote_to_local_port_mappings: [
      {
        remote_tcp_port: 46100,
        local_tcp_port: 46200
      }
    ],
    reconnect_strategy: {
      enabled: true,
      base_interval_ms: 10,
      max_interval_ms: 10,
      max_attempts: params.max_attempts,
      jitter_ratio: 0
    },
    auth: {
      username: 'some_user',
      password: 'some_password'
    }
  };
}

class ObservableFakeRuntime extends EventEmitter implements tunnel_runtime_i {
  private readonly tunnel_definition: tunnel_definition_t;
  private state: tunnel_status_i['state'];

  constructor(params: { tunnel_definition: tunnel_definition_t }) {
    super();
    this.tunnel_definition = params.tunnel_definition;
    this.state = 'defined';
  }

  async connect(): Promise<tunnel_status_i> {
    this.state = 'connected';

    const connected_status = this.getStatus();

    this.emit('connected', {
      tunnel_name: this.tunnel_definition.name,
      status: connected_status
    } satisfies ssh_tunnel_runtime_event_map_i['connected']);

    return connected_status;
  }

  async disconnect(): Promise<tunnel_status_i> {
    this.state = 'disconnected';

    const disconnected_status = this.getStatus();

    this.emit('disconnected', {
      tunnel_name: this.tunnel_definition.name,
      status: disconnected_status,
      reason: 'manual_disconnect'
    } satisfies ssh_tunnel_runtime_event_map_i['disconnected']);

    return disconnected_status;
  }

  getStatus(): tunnel_status_i {
    const reconnect_strategy = this.tunnel_definition.reconnect_strategy;

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
}

test('SSHTunnelRuntime emits connected/disconnected/reconnecting/reconnect_failed/forward_established events.', async function () {
  ObservabilityFakeSSHClient.Reset({
    close_after_ready_connect_attempts: [1],
    connect_error_attempts: [2]
  });

  const tunnel_runtime = new SSHTunnelRuntime({
    tunnel_definition: CreateEventTunnelDefinition({
      name: 'runtime_events',
      max_attempts: 3
    }),
    ssh_client_constructor: ObservabilityFakeSSHClient
  });

  const event_history: Array<keyof ssh_tunnel_runtime_event_map_i> = [];

  tunnel_runtime.on('connected', () => {
    event_history.push('connected');
  });

  tunnel_runtime.on('disconnected', () => {
    event_history.push('disconnected');
  });

  tunnel_runtime.on('reconnecting', () => {
    event_history.push('reconnecting');
  });

  tunnel_runtime.on('reconnect_failed', () => {
    event_history.push('reconnect_failed');
  });

  tunnel_runtime.on('forward_established', () => {
    event_history.push('forward_established');
  });

  await tunnel_runtime.connect();
  await Delay(150);
  await tunnel_runtime.disconnect();

  assert.strictEqual(event_history.includes('connected'), true);
  assert.strictEqual(event_history.includes('disconnected'), true);
  assert.strictEqual(event_history.includes('reconnecting'), true);
  assert.strictEqual(event_history.includes('reconnect_failed'), true);
  assert.strictEqual(event_history.includes('forward_established'), true);

  const tunnel_status = tunnel_runtime.getStatus();
  assert.strictEqual(tunnel_status.state, 'disconnected');
  assert.strictEqual(tunnel_status.reconnect_info.attempt_count, 2);
});

test('SSHTunnelRuntime emits forward_failed when forward binding setup fails.', async function () {
  ObservabilityFakeSSHClient.Reset({
    forward_in_error_attempts: [1]
  });

  const tunnel_runtime = new SSHTunnelRuntime({
    tunnel_definition: CreateEventTunnelDefinition({
      name: 'forward_failed_events',
      max_attempts: 1
    }),
    ssh_client_constructor: ObservabilityFakeSSHClient
  });

  const forward_failed_events: ssh_tunnel_runtime_event_map_i['forward_failed'][] = [];

  tunnel_runtime.on('forward_failed', (event_payload) => {
    forward_failed_events.push(event_payload);
  });

  await assert.rejects(async function () {
    await tunnel_runtime.connect();
  });

  assert.strictEqual(forward_failed_events.length, 1);
  assert.strictEqual(forward_failed_events[0]?.direction, 'remote_to_local');

  await tunnel_runtime.disconnect();
});

test('SSHTunnel manager re-emits runtime observability events.', async function () {
  const tunnel_runtime_factory: tunnel_runtime_factory_t = function BuildRuntime(params: {
    tunnel_definition: tunnel_definition_t;
  }): tunnel_runtime_i {
    return new ObservableFakeRuntime({
      tunnel_definition: params.tunnel_definition
    });
  };

  const manager = new SSHTunnel({
    tunnel_runtime_factory
  });

  manager.defineTunnel(
    CreateEventTunnelDefinition({
      name: 'manager_events',
      max_attempts: 1
    })
  );

  const connected_events: ssh_tunnel_runtime_event_map_i['connected'][] = [];

  manager.on('connected', (event_payload) => {
    connected_events.push(event_payload);
  });

  await manager.startTunnel({
    name: 'manager_events'
  });

  assert.strictEqual(connected_events.length, 1);
  assert.strictEqual(connected_events[0]?.tunnel_name, 'manager_events');
});
