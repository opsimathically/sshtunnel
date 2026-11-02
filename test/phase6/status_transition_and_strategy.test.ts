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

class StableFakeSSHClient extends EventEmitter implements ssh_client_i {
  static connect_attempt_count = 0;

  static Reset(): void {
    StableFakeSSHClient.connect_attempt_count = 0;
  }

  connect(params: ssh_connect_options_i): void {
    void params;

    StableFakeSSHClient.connect_attempt_count += 1;

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

function CreateDefaultStrategyTunnelDefinition(params: {
  name: string;
}): tunnel_definition_t {
  return {
    name: params.name,
    host: '127.0.0.1',
    port: 22,
    local_to_remote_port_mappings: [],
    remote_to_local_port_mappings: [
      {
        remote_tcp_port: 47100,
        local_tcp_port: 47200
      }
    ],
    auth: {
      username: 'some_user',
      password: 'some_password'
    }
  };
}

test('SSHTunnelRuntime exposes default reconnect strategy values in status.', async function () {
  StableFakeSSHClient.Reset();

  const tunnel_runtime = new SSHTunnelRuntime({
    tunnel_definition: CreateDefaultStrategyTunnelDefinition({
      name: 'default_strategy'
    }),
    ssh_client_constructor: StableFakeSSHClient
  });

  await tunnel_runtime.connect();

  const connected_status = tunnel_runtime.getStatus();

  assert.strictEqual(connected_status.state, 'connected');
  assert.strictEqual(connected_status.reconnect_info.enabled, true);
  assert.strictEqual(connected_status.reconnect_info.base_interval_ms, 1000);
  assert.strictEqual(connected_status.reconnect_info.max_interval_ms, 30000);
  assert.strictEqual(connected_status.reconnect_info.max_attempts, 'infinite');
  assert.strictEqual(connected_status.reconnect_info.jitter_ratio, 0.2);
  assert.strictEqual(connected_status.reconnect_info.attempt_count, 0);

  await tunnel_runtime.disconnect();
});

test('SSHTunnelRuntime status transitions remain disconnected after manual disconnect.', async function () {
  StableFakeSSHClient.Reset();

  const tunnel_runtime = new SSHTunnelRuntime({
    tunnel_definition: CreateDefaultStrategyTunnelDefinition({
      name: 'manual_disconnect'
    }),
    ssh_client_constructor: StableFakeSSHClient
  });

  await tunnel_runtime.connect();
  await tunnel_runtime.disconnect();
  await Delay(50);

  const disconnected_status = tunnel_runtime.getStatus();

  assert.strictEqual(disconnected_status.state, 'disconnected');
  assert.strictEqual(disconnected_status.reconnect_attempt_count, 0);
  assert.strictEqual(StableFakeSSHClient.connect_attempt_count, 1);
});
