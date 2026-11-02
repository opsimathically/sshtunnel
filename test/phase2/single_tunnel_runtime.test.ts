import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import test from 'node:test';
import { PassThrough } from 'node:stream';

import {
  BuildSSHClientConnectOptions,
  SSHTunnelRuntime,
  type ssh_client_i,
  type ssh_connect_options_i,
  type tunnel_definition_t
} from '@src/index';

type forward_in_call_t = {
  bind_address: string;
  bind_port: number;
};

type unforward_in_call_t = {
  bind_address: string;
  bind_port: number;
};

class FakeSSHClient extends EventEmitter implements ssh_client_i {
  static created_instances: FakeSSHClient[] = [];

  public last_connect_options: ssh_connect_options_i | undefined;
  public forward_in_calls: forward_in_call_t[];
  public unforward_in_calls: unforward_in_call_t[];
  public end_called: boolean;

  constructor() {
    super();

    this.last_connect_options = undefined;
    this.forward_in_calls = [];
    this.unforward_in_calls = [];
    this.end_called = false;

    FakeSSHClient.created_instances.push(this);
  }

  connect(params: ssh_connect_options_i): void {
    this.last_connect_options = params;

    process.nextTick(() => {
      this.emit('ready');
    });
  }

  end(): void {
    this.end_called = true;

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
    this.forward_in_calls.push({
      bind_address,
      bind_port
    });

    callback(undefined);
  }

  unforwardIn(
    bind_address: string,
    bind_port: number,
    callback: (error?: Error | undefined) => void
  ): void {
    this.unforward_in_calls.push({
      bind_address,
      bind_port
    });

    callback(undefined);
  }

  removeAllListeners(event_name?: string | symbol): this {
    return super.removeAllListeners(event_name);
  }
}

async function GetOpenPort(): Promise<number> {
  const open_port = await new Promise<number>((resolve, reject) => {
    const server = createServer();

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address_info = server.address();

      if (address_info === null || typeof address_info === 'string') {
        reject(new Error('Could not resolve open port.'));
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

  return open_port;
}

test('BuildSSHClientConnectOptions maps username/password auth.', async function () {
  const connect_options = BuildSSHClientConnectOptions({
    tunnel_definition: {
      name: 'password_auth_tunnel',
      host: '127.0.0.1',
      port: 22,
      local_to_remote_port_mappings: [
        {
          local_tcp_port: 31001,
          remote_tcp_port: 32001
        }
      ],
      remote_to_local_port_mappings: [],
      auth: {
        username: 'password_user',
        password: 'password_secret'
      }
    }
  });

  assert.strictEqual(connect_options.username, 'password_user');
  assert.strictEqual(connect_options.password, 'password_secret');
  assert.strictEqual(connect_options.privateKey, undefined);
});

test('BuildSSHClientConnectOptions maps private-key auth.', async function () {
  const connect_options = BuildSSHClientConnectOptions({
    tunnel_definition: {
      name: 'key_auth_tunnel',
      host: '127.0.0.1',
      port: 22,
      local_to_remote_port_mappings: [
        {
          local_tcp_port: 31002,
          remote_tcp_port: 32002
        }
      ],
      remote_to_local_port_mappings: [],
      auth: {
        username: 'key_user',
        private_key: 'PRIVATE_KEY_STRING',
        passphrase: 'optional_passphrase'
      }
    }
  });

  assert.strictEqual(connect_options.username, 'key_user');
  assert.strictEqual(connect_options.privateKey, 'PRIVATE_KEY_STRING');
  assert.strictEqual(connect_options.passphrase, 'optional_passphrase');
  assert.strictEqual(connect_options.password, undefined);
});

test('SSHTunnelRuntime connects and disconnects for remote-to-local forwarding.', async function () {
  FakeSSHClient.created_instances = [];

  const tunnel_runtime = new SSHTunnelRuntime({
    tunnel_definition: {
      name: 'remote_to_local_tunnel',
      host: '127.0.0.1',
      port: 22,
      local_to_remote_port_mappings: [],
      remote_to_local_port_mappings: [
        {
          remote_tcp_port: 33001,
          local_tcp_port: 34001
        }
      ],
      auth: {
        username: 'remote_user',
        password: 'remote_password'
      }
    },
    ssh_client_constructor: FakeSSHClient
  });

  const connected_status = await tunnel_runtime.connect();
  assert.strictEqual(connected_status.state, 'connected');

  const fake_client = FakeSSHClient.created_instances[0];
  assert.notStrictEqual(fake_client, undefined);

  if (fake_client === undefined) {
    throw new Error('Expected fake SSH client instance to exist.');
  }

  assert.strictEqual(fake_client.forward_in_calls.length, 1);

  const disconnected_status = await tunnel_runtime.disconnect();
  assert.strictEqual(disconnected_status.state, 'disconnected');
  assert.strictEqual(fake_client.unforward_in_calls.length, 1);
  assert.strictEqual(fake_client.end_called, true);
});

test('SSHTunnelRuntime connects and disconnects for local-to-remote forwarding.', async function () {
  FakeSSHClient.created_instances = [];

  const local_open_port = await GetOpenPort();

  const tunnel_definition: tunnel_definition_t = {
    name: 'local_to_remote_tunnel',
    host: '127.0.0.1',
    port: 22,
    local_to_remote_port_mappings: [
      {
        local_tcp_port: local_open_port,
        remote_tcp_port: 35001
      }
    ],
    remote_to_local_port_mappings: [],
    auth: {
      username: 'local_user',
      password: 'local_password'
    }
  };

  const tunnel_runtime = new SSHTunnelRuntime({
    tunnel_definition,
    ssh_client_constructor: FakeSSHClient
  });

  const connected_status = await tunnel_runtime.connect();
  assert.strictEqual(connected_status.state, 'connected');

  const disconnected_status = await tunnel_runtime.disconnect();
  assert.strictEqual(disconnected_status.state, 'disconnected');
});
