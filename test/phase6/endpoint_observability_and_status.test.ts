import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
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

async function GetOpenPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address_info = server.address();

      if (address_info === null || typeof address_info === 'string') {
        reject(new Error('Could not resolve an open port.'));
        return;
      }

      server.close((close_error) => {
        if (close_error !== undefined) {
          reject(close_error);
          return;
        }

        resolve(address_info.port);
      });
    });
  });
}

class Phase6StreamLocalReadySSHClient extends EventEmitter implements ssh_client_i {
  connect(params: ssh_connect_options_i): void {
    void params;
    process.nextTick(() => {
      this.emit('ready');
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

  openssh_forwardOutStreamLocal(
    socket_path: string,
    callback: (error: Error | undefined, stream: PassThrough | undefined) => void
  ): void {
    void socket_path;
    callback(undefined, new PassThrough());
  }

  removeAllListeners(event_name?: string | symbol): this {
    return super.removeAllListeners(event_name);
  }
}

class Phase6NoStreamLocalInSSHClient extends EventEmitter implements ssh_client_i {
  connect(params: ssh_connect_options_i): void {
    void params;
    process.nextTick(() => {
      this.emit('ready');
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

class Phase6ObservableRuntime extends EventEmitter implements tunnel_runtime_i {
  private readonly tunnel_definition: tunnel_definition_t;

  constructor(params: { tunnel_definition: tunnel_definition_t }) {
    super();
    this.tunnel_definition = params.tunnel_definition;
  }

  async connect(): Promise<tunnel_status_i> {
    const connected_status = this.getStatus({
      state: 'connected'
    });

    const endpoint_mapping = this.tunnel_definition.local_to_remote_endpoint_mappings?.[0];

    if (endpoint_mapping !== undefined) {
      this.emit('forward_established', {
        tunnel_name: this.tunnel_definition.name,
        direction: 'local_to_remote',
        endpoint_mapping
      } satisfies ssh_tunnel_runtime_event_map_i['forward_established']);
    }

    return connected_status;
  }

  async disconnect(): Promise<tunnel_status_i> {
    return this.getStatus({
      state: 'disconnected'
    });
  }

  getStatus(params?: { state?: tunnel_status_i['state'] | undefined }): tunnel_status_i {
    return {
      name: this.tunnel_definition.name,
      host: this.tunnel_definition.host,
      port: this.tunnel_definition.port,
      state: params?.state ?? 'defined',
      local_to_remote_port_mappings: this.tunnel_definition.local_to_remote_port_mappings,
      remote_to_local_port_mappings: this.tunnel_definition.remote_to_local_port_mappings,
      local_to_remote_endpoint_mappings:
        this.tunnel_definition.local_to_remote_endpoint_mappings ?? [],
      remote_to_local_endpoint_mappings:
        this.tunnel_definition.remote_to_local_endpoint_mappings ?? [],
      reconnect_attempt_count: 0,
      reconnect_info: {
        enabled: true,
        base_interval_ms: 1000,
        max_interval_ms: 30000,
        max_attempts: 'infinite',
        jitter_ratio: 0.2,
        attempt_count: 0
      },
      updated_at_iso_8601: new Date().toISOString()
    };
  }
}

test('SSHTunnelRuntime emits endpoint-aware forward_established for UNIX mappings.', async function () {
  const local_tcp_port = await GetOpenPort();

  const tunnel_runtime = new SSHTunnelRuntime({
    tunnel_definition: {
      name: 'phase6_forward_established_unix',
      host: '127.0.0.1',
      port: 22,
      local_to_remote_port_mappings: [],
      remote_to_local_port_mappings: [],
      local_to_remote_endpoint_mappings: [
        {
          local_endpoint: {
            endpoint_type: 'tcp',
            tcp_port: local_tcp_port
          },
          remote_endpoint: {
            endpoint_type: 'unix_socket',
            socket_path: '/run/phase6_remote.sock'
          }
        }
      ],
      auth: {
        username: 'some_user',
        password: 'some_password'
      }
    },
    ssh_client_constructor: Phase6StreamLocalReadySSHClient
  });

  const forward_established_events: ssh_tunnel_runtime_event_map_i['forward_established'][] =
    [];

  tunnel_runtime.on('forward_established', (event_payload) => {
    forward_established_events.push(event_payload);
  });

  await tunnel_runtime.connect();

  assert.strictEqual(forward_established_events.length, 1);
  assert.strictEqual(
    forward_established_events[0]?.endpoint_mapping.local_endpoint.endpoint_type,
    'tcp'
  );
  assert.strictEqual(
    forward_established_events[0]?.endpoint_mapping.remote_endpoint.endpoint_type,
    'unix_socket'
  );
  assert.strictEqual(forward_established_events[0]?.mapping, undefined);

  const runtime_status = tunnel_runtime.getStatus();
  assert.strictEqual(runtime_status.local_to_remote_endpoint_mappings.length, 1);
  assert.strictEqual(runtime_status.remote_to_local_endpoint_mappings.length, 0);

  await tunnel_runtime.disconnect();
});

test('SSHTunnelRuntime emits endpoint-aware forward_failed for UNIX mappings.', async function () {
  const local_tcp_port = await GetOpenPort();

  const tunnel_runtime = new SSHTunnelRuntime({
    tunnel_definition: {
      name: 'phase6_forward_failed_unix',
      host: '127.0.0.1',
      port: 22,
      local_to_remote_port_mappings: [],
      remote_to_local_port_mappings: [],
      remote_to_local_endpoint_mappings: [
        {
          remote_endpoint: {
            endpoint_type: 'unix_socket',
            socket_path: '/run/phase6_remote_in.sock'
          },
          local_endpoint: {
            endpoint_type: 'tcp',
            tcp_port: local_tcp_port
          }
        }
      ],
      auth: {
        username: 'some_user',
        password: 'some_password'
      }
    },
    ssh_client_constructor: Phase6NoStreamLocalInSSHClient
  });

  const forward_failed_events: ssh_tunnel_runtime_event_map_i['forward_failed'][] = [];

  tunnel_runtime.on('forward_failed', (event_payload) => {
    forward_failed_events.push(event_payload);
  });

  await assert.rejects(async function () {
    await tunnel_runtime.connect();
  });

  assert.strictEqual(forward_failed_events.length, 1);
  assert.strictEqual(
    forward_failed_events[0]?.endpoint_mapping.remote_endpoint.endpoint_type,
    'unix_socket'
  );
  assert.strictEqual(
    forward_failed_events[0]?.endpoint_mapping.local_endpoint.endpoint_type,
    'tcp'
  );
  assert.strictEqual(forward_failed_events[0]?.mapping, undefined);
  assert.strictEqual(
    forward_failed_events[0]?.error_message.includes('remote-to-local mapping'),
    true
  );

  await tunnel_runtime.disconnect();
});

test('SSHTunnel manager re-emits endpoint-aware forward events for UNIX mappings.', async function () {
  const tunnel_runtime_factory: tunnel_runtime_factory_t = function BuildRuntime(params: {
    tunnel_definition: tunnel_definition_t;
  }): tunnel_runtime_i {
    return new Phase6ObservableRuntime({
      tunnel_definition: params.tunnel_definition
    });
  };

  const manager = new SSHTunnel({
    tunnel_runtime_factory
  });

  manager.defineTunnel({
    name: 'phase6_manager_forward_events',
    host: '127.0.0.1',
    port: 22,
    local_to_remote_endpoint_mappings: [
      {
        local_endpoint: {
          endpoint_type: 'tcp',
          tcp_port: 48901
        },
        remote_endpoint: {
          endpoint_type: 'unix_socket',
          socket_path: '/run/phase6_manager.sock'
        }
      }
    ],
    auth: {
      username: 'some_user',
      password: 'some_password'
    }
  });

  const manager_forward_events: ssh_tunnel_runtime_event_map_i['forward_established'][] =
    [];

  manager.on('forward_established', (event_payload) => {
    manager_forward_events.push(event_payload);
  });

  await manager.startTunnel({
    name: 'phase6_manager_forward_events'
  });

  assert.strictEqual(manager_forward_events.length, 1);
  assert.strictEqual(
    manager_forward_events[0]?.endpoint_mapping.remote_endpoint.endpoint_type,
    'unix_socket'
  );
});

test('SSHTunnel tunnelStatus includes normalized endpoint mapping metadata.', async function () {
  const manager = new SSHTunnel();

  manager.defineTunnel({
    name: 'phase6_status_normalized_endpoints',
    host: '127.0.0.1',
    port: 22,
    local_to_remote_port_mappings: [
      {
        local_tcp_port: 48911,
        remote_tcp_port: 48912
      }
    ],
    remote_to_local_port_mappings: [
      {
        remote_tcp_port: 48921,
        local_tcp_port: 48922
      }
    ],
    auth: {
      username: 'some_user',
      password: 'some_password'
    }
  });

  const tunnel_statuses = await manager.tunnelStatus();
  assert.strictEqual(tunnel_statuses.length, 1);

  const tunnel_status = tunnel_statuses[0];
  assert.notStrictEqual(tunnel_status, undefined);
  assert.strictEqual(tunnel_status?.local_to_remote_endpoint_mappings.length, 1);
  assert.strictEqual(tunnel_status?.remote_to_local_endpoint_mappings.length, 1);
  assert.strictEqual(
    tunnel_status?.local_to_remote_endpoint_mappings[0]?.local_endpoint.endpoint_type,
    'tcp'
  );
  assert.strictEqual(
    tunnel_status?.remote_to_local_endpoint_mappings[0]?.remote_endpoint.endpoint_type,
    'tcp'
  );
});
