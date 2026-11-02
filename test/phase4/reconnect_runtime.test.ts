import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { setTimeout as Delay } from 'node:timers/promises';
import test from 'node:test';
import { PassThrough } from 'node:stream';

import {
  SSHTunnelRuntime,
  type ssh_client_i,
  type ssh_connect_options_i,
  type tunnel_definition_t
} from '@src/index';

type reconnect_fake_config_t = {
  close_after_ready_connect_attempts: Set<number>;
  error_connect_attempts: Set<number>;
};

class ReconnectFakeSSHClient extends EventEmitter implements ssh_client_i {
  static connect_attempt_count = 0;
  static forward_in_call_count = 0;
  static config: reconnect_fake_config_t = {
    close_after_ready_connect_attempts: new Set<number>(),
    error_connect_attempts: new Set<number>()
  };

  static Reset(params?: {
    close_after_ready_connect_attempts?: number[];
    error_connect_attempts?: number[];
  }): void {
    ReconnectFakeSSHClient.connect_attempt_count = 0;
    ReconnectFakeSSHClient.forward_in_call_count = 0;
    ReconnectFakeSSHClient.config = {
      close_after_ready_connect_attempts: new Set(
        params?.close_after_ready_connect_attempts ?? []
      ),
      error_connect_attempts: new Set(params?.error_connect_attempts ?? [])
    };
  }

  connect(params: ssh_connect_options_i): void {
    void params;

    ReconnectFakeSSHClient.connect_attempt_count += 1;
    const connect_attempt_number = ReconnectFakeSSHClient.connect_attempt_count;

    if (ReconnectFakeSSHClient.config.error_connect_attempts.has(connect_attempt_number)) {
      process.nextTick(() => {
        this.emit('error', new Error(`Connect failure ${connect_attempt_number}`));
        this.emit('close', true);
      });

      return;
    }

    process.nextTick(() => {
      this.emit('ready');

      if (
        ReconnectFakeSSHClient.config.close_after_ready_connect_attempts.has(
          connect_attempt_number
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

    ReconnectFakeSSHClient.forward_in_call_count += 1;
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

function CreateReconnectTunnelDefinition(params: {
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
        remote_tcp_port: 45100,
        local_tcp_port: 45200
      }
    ],
    reconnect_strategy: {
      enabled: true,
      base_interval_ms: 10,
      max_interval_ms: 20,
      max_attempts: params.max_attempts,
      jitter_ratio: 0
    },
    auth: {
      username: 'some_user',
      password: 'some_password'
    }
  };
}

test('SSHTunnelRuntime reconnects after unexpected drop and re-binds forwards.', async function () {
  ReconnectFakeSSHClient.Reset({
    close_after_ready_connect_attempts: [1]
  });

  const tunnel_runtime = new SSHTunnelRuntime({
    tunnel_definition: CreateReconnectTunnelDefinition({
      name: 'reconnect_success',
      max_attempts: 3
    }),
    ssh_client_constructor: ReconnectFakeSSHClient
  });

  await tunnel_runtime.connect();
  await Delay(100);

  const tunnel_status = tunnel_runtime.getStatus();

  assert.strictEqual(tunnel_status.state, 'connected');
  assert.strictEqual(tunnel_status.reconnect_attempt_count, 1);
  assert.strictEqual(ReconnectFakeSSHClient.connect_attempt_count >= 2, true);
  assert.strictEqual(ReconnectFakeSSHClient.forward_in_call_count >= 2, true);

  await tunnel_runtime.disconnect();
});

test('SSHTunnelRuntime stops reconnecting after max attempts are exhausted.', async function () {
  ReconnectFakeSSHClient.Reset({
    close_after_ready_connect_attempts: [1],
    error_connect_attempts: [2, 3, 4]
  });

  const tunnel_runtime = new SSHTunnelRuntime({
    tunnel_definition: CreateReconnectTunnelDefinition({
      name: 'reconnect_exhausted',
      max_attempts: 2
    }),
    ssh_client_constructor: ReconnectFakeSSHClient
  });

  await tunnel_runtime.connect();
  await Delay(150);

  const tunnel_status = tunnel_runtime.getStatus();

  assert.strictEqual(tunnel_status.state, 'failed');
  assert.strictEqual(tunnel_status.reconnect_attempt_count, 2);
  assert.strictEqual(ReconnectFakeSSHClient.connect_attempt_count, 3);

  await tunnel_runtime.disconnect();
});
