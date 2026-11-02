import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { lstat, unlink } from 'node:fs/promises';
import { createServer, connect } from 'node:net';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { setTimeout as Delay } from 'node:timers/promises';

import {
  SSHTunnelRuntime,
  type ssh_client_i,
  type ssh_connect_options_i,
  type ssh_tunnel_runtime_event_map_i
} from '@src/index';

type phase5_fake_config_t = {
  close_after_ready_connect_attempts: Set<number>;
  fail_forward_in_tcp_ports_by_attempt: Map<number, Set<number>>;
};

class Phase5MixedFakeSSHClient extends EventEmitter implements ssh_client_i {
  static created_instances: Phase5MixedFakeSSHClient[] = [];
  static connect_attempt_count = 0;
  static forward_in_tcp_call_count = 0;
  static forward_in_unix_call_count = 0;
  static forward_out_tcp_call_count = 0;
  static forward_out_unix_call_count = 0;
  static config: phase5_fake_config_t = {
    close_after_ready_connect_attempts: new Set<number>(),
    fail_forward_in_tcp_ports_by_attempt: new Map<number, Set<number>>()
  };

  private current_connect_attempt_number: number;

  constructor() {
    super();
    this.current_connect_attempt_number = 0;
    Phase5MixedFakeSSHClient.created_instances.push(this);
  }

  static Reset(params?: {
    close_after_ready_connect_attempts?: number[];
    fail_forward_in_tcp_ports_by_attempt?: Record<number, number[]>;
  }): void {
    Phase5MixedFakeSSHClient.created_instances = [];
    Phase5MixedFakeSSHClient.connect_attempt_count = 0;
    Phase5MixedFakeSSHClient.forward_in_tcp_call_count = 0;
    Phase5MixedFakeSSHClient.forward_in_unix_call_count = 0;
    Phase5MixedFakeSSHClient.forward_out_tcp_call_count = 0;
    Phase5MixedFakeSSHClient.forward_out_unix_call_count = 0;

    const fail_forward_in_tcp_ports_by_attempt = new Map<number, Set<number>>();

    for (const [attempt_number_string, tcp_ports] of Object.entries(
      params?.fail_forward_in_tcp_ports_by_attempt ?? {}
    )) {
      fail_forward_in_tcp_ports_by_attempt.set(
        Number(attempt_number_string),
        new Set<number>(tcp_ports)
      );
    }

    Phase5MixedFakeSSHClient.config = {
      close_after_ready_connect_attempts: new Set(
        params?.close_after_ready_connect_attempts ?? []
      ),
      fail_forward_in_tcp_ports_by_attempt
    };
  }

  connect(params: ssh_connect_options_i): void {
    void params;

    Phase5MixedFakeSSHClient.connect_attempt_count += 1;
    this.current_connect_attempt_number = Phase5MixedFakeSSHClient.connect_attempt_count;

    process.nextTick(() => {
      this.emit('ready');

      if (
        Phase5MixedFakeSSHClient.config.close_after_ready_connect_attempts.has(
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

    Phase5MixedFakeSSHClient.forward_out_tcp_call_count += 1;
    callback(undefined, new PassThrough());
  }

  openssh_forwardOutStreamLocal(
    socket_path: string,
    callback: (error: Error | undefined, stream: PassThrough | undefined) => void
  ): void {
    void socket_path;

    Phase5MixedFakeSSHClient.forward_out_unix_call_count += 1;
    callback(undefined, new PassThrough());
  }

  forwardIn(
    bind_address: string,
    bind_port: number,
    callback: (error?: Error | undefined) => void
  ): void {
    void bind_address;

    const failing_ports_for_attempt =
      Phase5MixedFakeSSHClient.config.fail_forward_in_tcp_ports_by_attempt.get(
        this.current_connect_attempt_number
      );

    if (failing_ports_for_attempt?.has(bind_port) === true) {
      callback(
        new Error(
          `forwardIn failure on attempt ${this.current_connect_attempt_number} for port ${bind_port}`
        )
      );
      return;
    }

    Phase5MixedFakeSSHClient.forward_in_tcp_call_count += 1;
    callback(undefined);
  }

  openssh_forwardInStreamLocal(
    socket_path: string,
    callback: (error?: Error | undefined) => void
  ): void {
    void socket_path;

    Phase5MixedFakeSSHClient.forward_in_unix_call_count += 1;
    callback(undefined);
  }

  openssh_unforwardInStreamLocal(
    socket_path: string,
    callback: (error?: Error | undefined) => void
  ): void {
    void socket_path;
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

function CreateSocketPath(params: { suffix: string }): string {
  return `/tmp/sshtunnel_phase5_${process.pid}_${Date.now()}_${params.suffix}.sock`;
}

async function RemoveSocketIfExists(params: { socket_path: string }): Promise<void> {
  try {
    await unlink(params.socket_path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }

    throw error;
  }
}

async function GetOpenPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe_server = createServer();

    probe_server.once('error', reject);
    probe_server.listen(0, '127.0.0.1', () => {
      const address_info = probe_server.address();

      if (address_info === null || typeof address_info === 'string') {
        reject(new Error('Could not allocate open port.'));
        return;
      }

      probe_server.close((close_error) => {
        if (close_error !== undefined) {
          reject(close_error);
          return;
        }

        resolve(address_info.port);
      });
    });
  });
}

test('SSHTunnelRuntime reconnects and re-binds mixed endpoint mappings.', async function () {
  Phase5MixedFakeSSHClient.Reset();

  const local_tcp_listener_port = await GetOpenPort();
  const local_unix_listener_path = CreateSocketPath({
    suffix: 'local_listener'
  });
  const local_tcp_target_port = await GetOpenPort();
  const local_unix_target_path = CreateSocketPath({
    suffix: 'local_target'
  });

  await RemoveSocketIfExists({
    socket_path: local_unix_listener_path
  });
  await RemoveSocketIfExists({
    socket_path: local_unix_target_path
  });

  const tunnel_runtime = new SSHTunnelRuntime({
    tunnel_definition: {
      name: 'mixed_rebind',
      host: '127.0.0.1',
      port: 22,
      local_to_remote_port_mappings: [],
      remote_to_local_port_mappings: [],
      local_to_remote_endpoint_mappings: [
        {
          local_endpoint: {
            endpoint_type: 'tcp',
            tcp_port: local_tcp_listener_port
          },
          remote_endpoint: {
            endpoint_type: 'tcp',
            tcp_port: 50101
          }
        },
        {
          local_endpoint: {
            endpoint_type: 'unix_socket',
            socket_path: local_unix_listener_path
          },
          remote_endpoint: {
            endpoint_type: 'unix_socket',
            socket_path: '/run/phase5_remote_out.sock'
          }
        }
      ],
      remote_to_local_endpoint_mappings: [
        {
          remote_endpoint: {
            endpoint_type: 'tcp',
            tcp_port: 50201
          },
          local_endpoint: {
            endpoint_type: 'tcp',
            tcp_port: local_tcp_target_port
          }
        },
        {
          remote_endpoint: {
            endpoint_type: 'unix_socket',
            socket_path: '/run/phase5_remote_in.sock'
          },
          local_endpoint: {
            endpoint_type: 'unix_socket',
            socket_path: local_unix_target_path
          }
        }
      ],
      reconnect_strategy: {
        enabled: true,
        base_interval_ms: 10,
        max_interval_ms: 20,
        max_attempts: 3,
        jitter_ratio: 0
      },
      auth: {
        username: 'some_user',
        password: 'some_password'
      }
    },
    ssh_client_constructor: Phase5MixedFakeSSHClient
  });

  await tunnel_runtime.connect();

  const tcp_client_one = connect({
    host: '127.0.0.1',
    port: local_tcp_listener_port
  });
  const unix_client_one = connect(local_unix_listener_path);
  tcp_client_one.end();
  unix_client_one.end();
  await Delay(30);

  assert.strictEqual(Phase5MixedFakeSSHClient.forward_out_tcp_call_count >= 1, true);
  assert.strictEqual(Phase5MixedFakeSSHClient.forward_out_unix_call_count >= 1, true);
  assert.strictEqual(Phase5MixedFakeSSHClient.forward_in_tcp_call_count >= 1, true);
  assert.strictEqual(Phase5MixedFakeSSHClient.forward_in_unix_call_count >= 1, true);

  const first_client = Phase5MixedFakeSSHClient.created_instances[0];
  assert.notStrictEqual(first_client, undefined);
  first_client?.emit('close', true);

  await Delay(120);

  const post_reconnect_status = tunnel_runtime.getStatus();
  assert.strictEqual(post_reconnect_status.state, 'connected');
  assert.strictEqual(post_reconnect_status.reconnect_attempt_count, 1);
  assert.strictEqual(Phase5MixedFakeSSHClient.connect_attempt_count >= 2, true);
  assert.strictEqual(Phase5MixedFakeSSHClient.forward_in_tcp_call_count >= 2, true);
  assert.strictEqual(Phase5MixedFakeSSHClient.forward_in_unix_call_count >= 2, true);

  const tcp_client_two = connect({
    host: '127.0.0.1',
    port: local_tcp_listener_port
  });
  const unix_client_two = connect(local_unix_listener_path);
  tcp_client_two.end();
  unix_client_two.end();
  await Delay(30);

  assert.strictEqual(Phase5MixedFakeSSHClient.forward_out_tcp_call_count >= 2, true);
  assert.strictEqual(Phase5MixedFakeSSHClient.forward_out_unix_call_count >= 2, true);

  await tunnel_runtime.disconnect();

  await assert.rejects(async function () {
    await lstat(local_unix_listener_path);
  }, function (error: unknown) {
    assert.strictEqual((error as NodeJS.ErrnoException).code, 'ENOENT');
    return true;
  });

  await RemoveSocketIfExists({
    socket_path: local_unix_listener_path
  });
  await RemoveSocketIfExists({
    socket_path: local_unix_target_path
  });
});

test('SSHTunnelRuntime surfaces partial mapping failures via forward/reconnect events and status.', async function () {
  Phase5MixedFakeSSHClient.Reset({
    fail_forward_in_tcp_ports_by_attempt: {
      2: [50302]
    }
  });

  const local_tcp_listener_port = await GetOpenPort();
  const local_unix_listener_path = CreateSocketPath({
    suffix: 'partial_listener'
  });

  await RemoveSocketIfExists({
    socket_path: local_unix_listener_path
  });

  const tunnel_runtime = new SSHTunnelRuntime({
    tunnel_definition: {
      name: 'partial_failure_surface',
      host: '127.0.0.1',
      port: 22,
      local_to_remote_port_mappings: [],
      remote_to_local_port_mappings: [],
      local_to_remote_endpoint_mappings: [
        {
          local_endpoint: {
            endpoint_type: 'tcp',
            tcp_port: local_tcp_listener_port
          },
          remote_endpoint: {
            endpoint_type: 'unix_socket',
            socket_path: '/run/phase5_partial_remote.sock'
          }
        },
        {
          local_endpoint: {
            endpoint_type: 'unix_socket',
            socket_path: local_unix_listener_path
          },
          remote_endpoint: {
            endpoint_type: 'tcp',
            tcp_port: 50404
          }
        }
      ],
      remote_to_local_endpoint_mappings: [
        {
          remote_endpoint: {
            endpoint_type: 'tcp',
            tcp_port: 50301
          },
          local_endpoint: {
            endpoint_type: 'tcp',
            tcp_port: 50401
          }
        },
        {
          remote_endpoint: {
            endpoint_type: 'tcp',
            tcp_port: 50302
          },
          local_endpoint: {
            endpoint_type: 'tcp',
            tcp_port: 50402
          }
        }
      ],
      reconnect_strategy: {
        enabled: true,
        base_interval_ms: 10,
        max_interval_ms: 20,
        max_attempts: 1,
        jitter_ratio: 0
      },
      auth: {
        username: 'some_user',
        password: 'some_password'
      }
    },
    ssh_client_constructor: Phase5MixedFakeSSHClient
  });

  const forward_failed_events: ssh_tunnel_runtime_event_map_i['forward_failed'][] = [];
  const reconnect_failed_events: ssh_tunnel_runtime_event_map_i['reconnect_failed'][] = [];
  let forward_established_event_count = 0;

  tunnel_runtime.on('forward_failed', (event_payload) => {
    forward_failed_events.push(event_payload);
  });

  tunnel_runtime.on('reconnect_failed', (event_payload) => {
    reconnect_failed_events.push(event_payload);
  });

  tunnel_runtime.on('forward_established', () => {
    forward_established_event_count += 1;
  });

  await tunnel_runtime.connect();

  const first_client = Phase5MixedFakeSSHClient.created_instances[0];
  first_client?.emit('close', true);
  await Delay(150);

  const failed_status = tunnel_runtime.getStatus();

  assert.strictEqual(failed_status.state, 'failed');
  assert.strictEqual(failed_status.reconnect_attempt_count, 1);
  assert.strictEqual(
    failed_status.last_error_message?.includes('remote-to-local mapping'),
    true
  );
  assert.strictEqual(failed_status.last_error_message?.includes('50302'), true);
  assert.strictEqual(forward_failed_events.length >= 1, true);
  assert.strictEqual(
    reconnect_failed_events.some((event_payload) =>
      event_payload.error_message.includes('50302')
    ),
    true
  );
  assert.strictEqual(forward_established_event_count >= 3, true);

  await tunnel_runtime.disconnect();

  await assert.rejects(async function () {
    await lstat(local_unix_listener_path);
  }, function (error: unknown) {
    assert.strictEqual((error as NodeJS.ErrnoException).code, 'ENOENT');
    return true;
  });

  await RemoveSocketIfExists({
    socket_path: local_unix_listener_path
  });
});
