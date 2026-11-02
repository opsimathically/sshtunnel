import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import test from 'node:test';
import { PassThrough } from 'node:stream';

import {
  SSHTunnelRuntime,
  type ssh_client_i,
  type ssh_connect_options_i,
  type ssh_tunnel_runtime_event_map_i,
  type tunnel_definition_t
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

class Phase7EventPayloadSSHClient extends EventEmitter implements ssh_client_i {
  private readonly fail_forward_in: boolean;

  constructor(params?: { fail_forward_in?: boolean | undefined }) {
    super();
    this.fail_forward_in = params?.fail_forward_in ?? false;
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

    if (this.fail_forward_in) {
      callback(new Error('forwardIn failed.'));
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

function BuildPayloadTunnelDefinition(params: {
  name: string;
  local_tcp_port: number;
  remote_tcp_port: number;
}): tunnel_definition_t {
  return {
    name: params.name,
    host: '127.0.0.1',
    port: 22,
    local_to_remote_port_mappings: [
      {
        local_tcp_port: params.local_tcp_port,
        remote_tcp_port: params.remote_tcp_port
      }
    ],
    remote_to_local_port_mappings: [
      {
        remote_tcp_port: params.remote_tcp_port + 1,
        local_tcp_port: params.local_tcp_port + 1
      }
    ],
    auth: {
      username: 'some_user',
      password: 'some_password'
    }
  };
}

test('SSHTunnelRuntime forward_established includes endpoint_mapping and legacy mapping for TCP mappings.', async function () {
  const local_tcp_port = await GetOpenPort();
  const tunnel_runtime = new SSHTunnelRuntime({
    tunnel_definition: BuildPayloadTunnelDefinition({
      name: 'phase7_forward_established_payload',
      local_tcp_port,
      remote_tcp_port: 53101
    }),
    ssh_client_constructor: Phase7EventPayloadSSHClient
  });

  const forward_established_events: ssh_tunnel_runtime_event_map_i['forward_established'][] =
    [];

  tunnel_runtime.on('forward_established', (event_payload) => {
    forward_established_events.push(event_payload);
  });

  await tunnel_runtime.connect();

  const local_to_remote_event = forward_established_events.find(
    (event_payload) => event_payload.direction === 'local_to_remote'
  );

  assert.notStrictEqual(local_to_remote_event, undefined);
  assert.strictEqual(
    local_to_remote_event?.endpoint_mapping.local_endpoint.endpoint_type,
    'tcp'
  );
  assert.strictEqual(
    local_to_remote_event?.endpoint_mapping.remote_endpoint.endpoint_type,
    'tcp'
  );
  assert.notStrictEqual(local_to_remote_event?.mapping, undefined);
  assert.strictEqual(
    local_to_remote_event?.mapping &&
      'local_tcp_port' in local_to_remote_event.mapping &&
      local_to_remote_event.mapping.local_tcp_port,
    local_tcp_port
  );

  await tunnel_runtime.disconnect();
});

test('SSHTunnelRuntime forward_failed includes endpoint_mapping and legacy mapping for TCP mappings.', async function () {
  const local_tcp_port = await GetOpenPort();

  const tunnel_runtime = new SSHTunnelRuntime({
    tunnel_definition: BuildPayloadTunnelDefinition({
      name: 'phase7_forward_failed_payload',
      local_tcp_port,
      remote_tcp_port: 53201
    }),
    ssh_client_constructor: class extends Phase7EventPayloadSSHClient {
      constructor() {
        super({
          fail_forward_in: true
        });
      }
    }
  });

  const forward_failed_events: ssh_tunnel_runtime_event_map_i['forward_failed'][] = [];

  tunnel_runtime.on('forward_failed', (event_payload) => {
    forward_failed_events.push(event_payload);
  });

  await assert.rejects(async function () {
    await tunnel_runtime.connect();
  });

  const remote_to_local_failed_event = forward_failed_events.find(
    (event_payload) => event_payload.direction === 'remote_to_local'
  );

  assert.notStrictEqual(remote_to_local_failed_event, undefined);
  assert.strictEqual(
    remote_to_local_failed_event?.endpoint_mapping.remote_endpoint.endpoint_type,
    'tcp'
  );
  assert.strictEqual(
    remote_to_local_failed_event?.endpoint_mapping.local_endpoint.endpoint_type,
    'tcp'
  );
  assert.notStrictEqual(remote_to_local_failed_event?.mapping, undefined);
  assert.strictEqual(
    remote_to_local_failed_event?.mapping &&
      'remote_tcp_port' in remote_to_local_failed_event.mapping &&
      remote_to_local_failed_event.mapping.remote_tcp_port,
    53202
  );
  assert.strictEqual(
    remote_to_local_failed_event?.error_message.includes('remote-to-local mapping'),
    true
  );

  await tunnel_runtime.disconnect();
});
