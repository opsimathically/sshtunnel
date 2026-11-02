import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { promises as FS } from 'node:fs';
import { createServer, connect } from 'node:net';
import type { AddressInfo, Server } from 'node:net';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { setTimeout as Delay } from 'node:timers/promises';

import {
  SSHTunnelError,
  SSHTunnelRuntime,
  type ssh_client_i,
  type ssh_connect_options_i,
  type tunnel_definition_t
} from '@src/index';
import type { ssh_tcp_connection_details_t } from '@src/types/runtime/ssh_runtime.types';

type forward_in_call_t = {
  bind_address: string;
  bind_port: number;
};

type unforward_in_call_t = {
  bind_address: string;
  bind_port: number;
};

type streamlocal_forward_in_call_t = {
  socket_path: string;
};

type streamlocal_unforward_in_call_t = {
  socket_path: string;
};

type forward_out_call_t = {
  dst_ip: string;
  dst_port: number;
};

type streamlocal_forward_out_call_t = {
  socket_path: string;
};

class StreamLocalFakeSSHClient extends EventEmitter implements ssh_client_i {
  static created_instances: StreamLocalFakeSSHClient[] = [];

  public forward_in_calls: forward_in_call_t[];
  public unforward_in_calls: unforward_in_call_t[];
  public streamlocal_forward_in_calls: streamlocal_forward_in_call_t[];
  public streamlocal_unforward_in_calls: streamlocal_unforward_in_call_t[];
  public forward_out_calls: forward_out_call_t[];
  public streamlocal_forward_out_calls: streamlocal_forward_out_call_t[];

  constructor() {
    super();

    this.forward_in_calls = [];
    this.unforward_in_calls = [];
    this.streamlocal_forward_in_calls = [];
    this.streamlocal_unforward_in_calls = [];
    this.forward_out_calls = [];
    this.streamlocal_forward_out_calls = [];

    StreamLocalFakeSSHClient.created_instances.push(this);
  }

  static Reset(): void {
    StreamLocalFakeSSHClient.created_instances = [];
  }

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
    this.forward_out_calls.push({
      dst_ip,
      dst_port
    });
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

  openssh_forwardOutStreamLocal(
    socket_path: string,
    callback: (error: Error | undefined, stream: PassThrough | undefined) => void
  ): void {
    this.streamlocal_forward_out_calls.push({
      socket_path
    });
    callback(undefined, new PassThrough());
  }

  openssh_forwardInStreamLocal(
    socket_path: string,
    callback: (error?: Error | undefined) => void
  ): void {
    this.streamlocal_forward_in_calls.push({
      socket_path
    });
    callback(undefined);
  }

  openssh_unforwardInStreamLocal(
    socket_path: string,
    callback: (error?: Error | undefined) => void
  ): void {
    this.streamlocal_unforward_in_calls.push({
      socket_path
    });
    callback(undefined);
  }

  removeAllListeners(event_name?: string | symbol): this {
    return super.removeAllListeners(event_name);
  }
}

class NoStreamLocalFakeSSHClient extends EventEmitter implements ssh_client_i {
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

function CreateSocketPath(params: { suffix: string }): string {
  return `/tmp/sshtunnel_phase3_${process.pid}_${Date.now()}_${params.suffix}.sock`;
}

async function RemoveSocketIfExists(params: { socket_path: string }): Promise<void> {
  try {
    await FS.unlink(params.socket_path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }

    throw error;
  }
}

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

async function CloseServer(params: { server: Server }): Promise<void> {
  await new Promise<void>((resolve) => {
    params.server.close(() => {
      resolve();
    });
  });
}

test('SSHTunnelRuntime supports local endpoint mappings for TCP<->UNIX combinations.', async function () {
  StreamLocalFakeSSHClient.Reset();

  const local_tcp_port = await GetOpenPort();
  const local_unix_socket_path_one = CreateSocketPath({
    suffix: 'local_one'
  });
  const local_unix_socket_path_two = CreateSocketPath({
    suffix: 'local_two'
  });

  const tunnel_definition: tunnel_definition_t = {
    name: 'local_mixed_endpoints',
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
          socket_path: '/run/remote_service_one.sock'
        }
      },
      {
        local_endpoint: {
          endpoint_type: 'unix_socket',
          socket_path: local_unix_socket_path_one
        },
        remote_endpoint: {
          endpoint_type: 'tcp',
          tcp_port: 47001
        }
      },
      {
        local_endpoint: {
          endpoint_type: 'unix_socket',
          socket_path: local_unix_socket_path_two
        },
        remote_endpoint: {
          endpoint_type: 'unix_socket',
          socket_path: '/run/remote_service_two.sock'
        }
      }
    ],
    auth: {
      username: 'some_user',
      password: 'some_password'
    }
  };

  const tunnel_runtime = new SSHTunnelRuntime({
    tunnel_definition,
    ssh_client_constructor: StreamLocalFakeSSHClient
  });

  await tunnel_runtime.connect();

  const fake_client = StreamLocalFakeSSHClient.created_instances[0];
  assert.notStrictEqual(fake_client, undefined);

  const local_tcp_client = connect({
    host: '127.0.0.1',
    port: local_tcp_port
  });
  const local_unix_client_one = connect(local_unix_socket_path_one);
  const local_unix_client_two = connect(local_unix_socket_path_two);

  local_tcp_client.end();
  local_unix_client_one.end();
  local_unix_client_two.end();

  await Delay(40);

  assert.strictEqual(fake_client?.forward_out_calls.length, 1);
  assert.strictEqual(fake_client?.streamlocal_forward_out_calls.length, 2);

  await tunnel_runtime.disconnect();

  await RemoveSocketIfExists({
    socket_path: local_unix_socket_path_one
  });
  await RemoveSocketIfExists({
    socket_path: local_unix_socket_path_two
  });
});

test('SSHTunnelRuntime supports remote endpoint mappings for TCP and UNIX forwarding combinations.', async function () {
  StreamLocalFakeSSHClient.Reset();

  const local_tcp_server = createServer();
  await new Promise<void>((resolve, reject) => {
    local_tcp_server.once('error', reject);
    local_tcp_server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const local_tcp_address = local_tcp_server.address() as AddressInfo;
  const local_tcp_port = local_tcp_address.port;

  const local_unix_socket_path_one = CreateSocketPath({
    suffix: 'remote_local_one'
  });
  const local_unix_socket_path_two = CreateSocketPath({
    suffix: 'remote_local_two'
  });

  const local_unix_server_one = createServer();
  const local_unix_server_two = createServer();

  await new Promise<void>((resolve, reject) => {
    local_unix_server_one.once('error', reject);
    local_unix_server_one.listen(local_unix_socket_path_one, () => {
      resolve();
    });
  });

  await new Promise<void>((resolve, reject) => {
    local_unix_server_two.once('error', reject);
    local_unix_server_two.listen(local_unix_socket_path_two, () => {
      resolve();
    });
  });

  let local_tcp_connection_count = 0;
  let local_unix_one_connection_count = 0;
  let local_unix_two_connection_count = 0;

  local_tcp_server.on('connection', (socket) => {
    local_tcp_connection_count += 1;
    socket.end();
  });
  local_unix_server_one.on('connection', (socket) => {
    local_unix_one_connection_count += 1;
    socket.end();
  });
  local_unix_server_two.on('connection', (socket) => {
    local_unix_two_connection_count += 1;
    socket.end();
  });

  const tunnel_definition: tunnel_definition_t = {
    name: 'remote_mixed_endpoints',
    host: '127.0.0.1',
    port: 22,
    local_to_remote_port_mappings: [],
    remote_to_local_port_mappings: [],
    remote_to_local_endpoint_mappings: [
      {
        remote_endpoint: {
          endpoint_type: 'tcp',
          tcp_port: 48001
        },
        local_endpoint: {
          endpoint_type: 'unix_socket',
          socket_path: local_unix_socket_path_one
        }
      },
      {
        remote_endpoint: {
          endpoint_type: 'unix_socket',
          socket_path: '/run/remote_incoming_one.sock'
        },
        local_endpoint: {
          endpoint_type: 'tcp',
          tcp_port: local_tcp_port
        }
      },
      {
        remote_endpoint: {
          endpoint_type: 'unix_socket',
          socket_path: '/run/remote_incoming_two.sock'
        },
        local_endpoint: {
          endpoint_type: 'unix_socket',
          socket_path: local_unix_socket_path_two
        }
      }
    ],
    auth: {
      username: 'some_user',
      password: 'some_password'
    }
  };

  const tunnel_runtime = new SSHTunnelRuntime({
    tunnel_definition,
    ssh_client_constructor: StreamLocalFakeSSHClient
  });

  await tunnel_runtime.connect();

  const fake_client = StreamLocalFakeSSHClient.created_instances[0];
  assert.notStrictEqual(fake_client, undefined);

  const tcp_accept = (): PassThrough => new PassThrough();
  const tcp_reject = (): void => {};
  const unix_accept = (): PassThrough => new PassThrough();
  const unix_reject = (): void => {};

  fake_client?.emit(
    'tcp connection',
    {
      destIP: '127.0.0.1',
      destPort: 48001,
      srcIP: '127.0.0.1',
      srcPort: 51001
    } satisfies ssh_tcp_connection_details_t,
    tcp_accept,
    tcp_reject
  );

  fake_client?.emit(
    'unix connection',
    {
      socketPath: '/run/remote_incoming_one.sock'
    },
    unix_accept,
    unix_reject
  );

  fake_client?.emit(
    'unix connection',
    {
      socket_path: '/run/remote_incoming_two.sock'
    },
    unix_accept,
    unix_reject
  );

  await Delay(40);

  assert.strictEqual(local_tcp_connection_count, 1);
  assert.strictEqual(local_unix_one_connection_count, 1);
  assert.strictEqual(local_unix_two_connection_count, 1);
  assert.strictEqual(fake_client?.forward_in_calls.length, 1);
  assert.strictEqual(fake_client?.streamlocal_forward_in_calls.length, 2);

  await tunnel_runtime.disconnect();

  assert.strictEqual(fake_client?.unforward_in_calls.length, 1);
  assert.strictEqual(fake_client?.streamlocal_unforward_in_calls.length, 2);

  await CloseServer({
    server: local_tcp_server
  });
  await CloseServer({
    server: local_unix_server_one
  });
  await CloseServer({
    server: local_unix_server_two
  });

  await RemoveSocketIfExists({
    socket_path: local_unix_socket_path_one
  });
  await RemoveSocketIfExists({
    socket_path: local_unix_socket_path_two
  });
});

test('SSHTunnelRuntime fails gracefully when streamlocal support is unavailable.', async function () {
  const local_tcp_port = await GetOpenPort();

  const tunnel_runtime = new SSHTunnelRuntime({
    tunnel_definition: {
      name: 'streamlocal_unsupported',
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
            socket_path: '/run/remote_missing.sock'
          }
        }
      ],
      auth: {
        username: 'some_user',
        password: 'some_password'
      }
    },
    ssh_client_constructor: NoStreamLocalFakeSSHClient
  });

  await assert.rejects(
    async function () {
      await tunnel_runtime.connect();
    },
    function (error: unknown) {
      assert(error instanceof SSHTunnelError);
      assert.strictEqual(error.code, 'forwarding_error');
      return true;
    }
  );
});
