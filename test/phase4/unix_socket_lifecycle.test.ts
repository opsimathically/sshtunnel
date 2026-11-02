import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { lstat, unlink, writeFile } from 'node:fs/promises';
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

class UnixLifecycleFakeSSHClient extends EventEmitter implements ssh_client_i {
  static connect_attempt_count = 0;
  static close_after_ready_connect_attempts = new Set<number>();

  static Reset(params?: { close_after_ready_connect_attempts?: number[] }): void {
    UnixLifecycleFakeSSHClient.connect_attempt_count = 0;
    UnixLifecycleFakeSSHClient.close_after_ready_connect_attempts = new Set(
      params?.close_after_ready_connect_attempts ?? []
    );
  }

  connect(params: ssh_connect_options_i): void {
    void params;

    UnixLifecycleFakeSSHClient.connect_attempt_count += 1;
    const connect_attempt_number = UnixLifecycleFakeSSHClient.connect_attempt_count;

    process.nextTick(() => {
      this.emit('ready');

      if (
        UnixLifecycleFakeSSHClient.close_after_ready_connect_attempts.has(
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
  return `/tmp/sshtunnel_phase4_${process.pid}_${Date.now()}_${params.suffix}.sock`;
}

async function RemoveFileIfPresent(params: { path: string }): Promise<void> {
  try {
    await unlink(params.path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }

    throw error;
  }
}

function CreateUnixLocalTunnelDefinition(params: {
  name: string;
  local_socket_path: string;
  reconnect_enabled?: boolean | undefined;
}): tunnel_definition_t {
  return {
    name: params.name,
    host: '127.0.0.1',
    port: 22,
    local_to_remote_port_mappings: [],
    remote_to_local_port_mappings: [],
    local_to_remote_endpoint_mappings: [
      {
        local_endpoint: {
          endpoint_type: 'unix_socket',
          socket_path: params.local_socket_path
        },
        remote_endpoint: {
          endpoint_type: 'tcp',
          tcp_port: 49123
        }
      }
    ],
    reconnect_strategy: {
      enabled: params.reconnect_enabled ?? true,
      base_interval_ms: 10,
      max_interval_ms: 20,
      max_attempts: 3,
      jitter_ratio: 0
    },
    auth: {
      username: 'some_user',
      password: 'some_password'
    }
  };
}

test('SSHTunnelRuntime removes local UNIX socket files on disconnect.', async function () {
  UnixLifecycleFakeSSHClient.Reset();

  const local_socket_path = CreateSocketPath({
    suffix: 'disconnect_cleanup'
  });

  await RemoveFileIfPresent({
    path: local_socket_path
  });

  const tunnel_runtime = new SSHTunnelRuntime({
    tunnel_definition: CreateUnixLocalTunnelDefinition({
      name: 'unix_disconnect_cleanup',
      local_socket_path
    }),
    ssh_client_constructor: UnixLifecycleFakeSSHClient
  });

  await tunnel_runtime.connect();

  const socket_stat = await lstat(local_socket_path);
  assert.strictEqual(socket_stat.isSocket(), true);

  await tunnel_runtime.disconnect();

  await assert.rejects(async function () {
    await lstat(local_socket_path);
  }, function (error: unknown) {
    assert.strictEqual((error as NodeJS.ErrnoException).code, 'ENOENT');
    return true;
  });
});

test('SSHTunnelRuntime re-binds UNIX local socket paths after reconnect.', async function () {
  UnixLifecycleFakeSSHClient.Reset({
    close_after_ready_connect_attempts: [1]
  });

  const local_socket_path = CreateSocketPath({
    suffix: 'reconnect_rebind'
  });

  await RemoveFileIfPresent({
    path: local_socket_path
  });

  const tunnel_runtime = new SSHTunnelRuntime({
    tunnel_definition: CreateUnixLocalTunnelDefinition({
      name: 'unix_reconnect_rebind',
      local_socket_path
    }),
    ssh_client_constructor: UnixLifecycleFakeSSHClient
  });

  await tunnel_runtime.connect();
  await Delay(120);

  const tunnel_status = tunnel_runtime.getStatus();

  assert.strictEqual(tunnel_status.state, 'connected');
  assert.strictEqual(tunnel_status.reconnect_attempt_count >= 1, true);
  assert.strictEqual(UnixLifecycleFakeSSHClient.connect_attempt_count >= 2, true);

  const socket_stat = await lstat(local_socket_path);
  assert.strictEqual(socket_stat.isSocket(), true);

  await tunnel_runtime.disconnect();

  await assert.rejects(async function () {
    await lstat(local_socket_path);
  }, function (error: unknown) {
    assert.strictEqual((error as NodeJS.ErrnoException).code, 'ENOENT');
    return true;
  });
});

test('SSHTunnelRuntime rejects UNIX local socket path when a non-socket file exists.', async function () {
  UnixLifecycleFakeSSHClient.Reset();

  const local_socket_path = CreateSocketPath({
    suffix: 'path_conflict_file'
  });

  await RemoveFileIfPresent({
    path: local_socket_path
  });
  await writeFile(local_socket_path, 'not a socket');

  const tunnel_runtime = new SSHTunnelRuntime({
    tunnel_definition: CreateUnixLocalTunnelDefinition({
      name: 'unix_non_socket_conflict',
      local_socket_path,
      reconnect_enabled: false
    }),
    ssh_client_constructor: UnixLifecycleFakeSSHClient
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

  await RemoveFileIfPresent({
    path: local_socket_path
  });
});

test('SSHTunnelRuntime rejects UNIX local socket paths that exceed platform limits.', async function () {
  UnixLifecycleFakeSSHClient.Reset();

  const local_socket_path = `/tmp/${'a'.repeat(180)}.sock`;

  const tunnel_runtime = new SSHTunnelRuntime({
    tunnel_definition: CreateUnixLocalTunnelDefinition({
      name: 'unix_path_too_long',
      local_socket_path,
      reconnect_enabled: false
    }),
    ssh_client_constructor: UnixLifecycleFakeSSHClient
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
