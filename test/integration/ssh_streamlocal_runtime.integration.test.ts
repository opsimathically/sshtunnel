import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import test from 'node:test';

import { SSHTunnelRuntime, type tunnel_definition_t } from '@src/index';

async function GetOpenPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
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
}

function BuildIntegrationAuth(): tunnel_definition_t['auth'] {
  const ssh_username = process.env.SSH_TUNNEL_INTEGRATION_USERNAME;

  if (ssh_username === undefined || ssh_username.trim() === '') {
    throw new Error('Missing SSH_TUNNEL_INTEGRATION_USERNAME.');
  }

  const ssh_password = process.env.SSH_TUNNEL_INTEGRATION_PASSWORD;
  const ssh_private_key = process.env.SSH_TUNNEL_INTEGRATION_PRIVATE_KEY;
  const ssh_private_key_path = process.env.SSH_TUNNEL_INTEGRATION_PRIVATE_KEY_PATH;

  if (ssh_password !== undefined && ssh_password !== '') {
    return {
      username: ssh_username,
      password: ssh_password
    };
  }

  if (ssh_private_key !== undefined && ssh_private_key !== '') {
    return {
      username: ssh_username,
      private_key: ssh_private_key,
      passphrase: process.env.SSH_TUNNEL_INTEGRATION_PRIVATE_KEY_PASSPHRASE
    };
  }

  if (ssh_private_key_path !== undefined && ssh_private_key_path !== '') {
    return {
      username: ssh_username,
      private_key: readFileSync(ssh_private_key_path, 'utf8'),
      passphrase: process.env.SSH_TUNNEL_INTEGRATION_PRIVATE_KEY_PASSPHRASE
    };
  }

  throw new Error(
    'Missing auth for streamlocal integration test. Provide SSH_TUNNEL_INTEGRATION_PASSWORD, SSH_TUNNEL_INTEGRATION_PRIVATE_KEY, or SSH_TUNNEL_INTEGRATION_PRIVATE_KEY_PATH.'
  );
}

function BuildStreamLocalIntegrationTunnelDefinition(params: {
  local_tcp_port: number;
  remote_socket_path: string;
}): tunnel_definition_t {
  const ssh_host = process.env.SSH_TUNNEL_INTEGRATION_HOST;
  const ssh_port_raw = process.env.SSH_TUNNEL_INTEGRATION_PORT;

  if (ssh_host === undefined || ssh_host.trim() === '') {
    throw new Error('Missing SSH_TUNNEL_INTEGRATION_HOST.');
  }

  const ssh_port = ssh_port_raw !== undefined ? Number(ssh_port_raw) : 22;

  return {
    name: 'integration_streamlocal_runtime_tunnel',
    host: ssh_host,
    port: ssh_port,
    local_to_remote_port_mappings: [],
    remote_to_local_port_mappings: [],
    remote_to_local_endpoint_mappings: [
      {
        remote_endpoint: {
          endpoint_type: 'unix_socket',
          socket_path: params.remote_socket_path
        },
        local_endpoint: {
          endpoint_type: 'tcp',
          tcp_port: params.local_tcp_port
        }
      }
    ],
    auth: BuildIntegrationAuth()
  };
}

test(
  'integration scaffold: runtime can establish and remove remote UNIX socket forwarding.',
  {
    skip:
      process.env.SSH_TUNNEL_STREAMLOCAL_INTEGRATION_ENABLED !== 'true'
        ? 'Set SSH_TUNNEL_STREAMLOCAL_INTEGRATION_ENABLED=true and SSH_TUNNEL_INTEGRATION_* env vars to run this test.'
        : false
  },
  async function () {
    const local_tcp_port = await GetOpenPort();
    const remote_socket_path =
      process.env.SSH_TUNNEL_STREAMLOCAL_REMOTE_SOCKET_PATH ??
      `/tmp/sshtunnel_streamlocal_${process.pid}_${Date.now()}.sock`;

    const tunnel_runtime = new SSHTunnelRuntime({
      tunnel_definition: BuildStreamLocalIntegrationTunnelDefinition({
        local_tcp_port,
        remote_socket_path
      })
    });

    const connected_status = await tunnel_runtime.connect();
    assert.strictEqual(connected_status.state, 'connected');

    const disconnected_status = await tunnel_runtime.disconnect();
    assert.strictEqual(disconnected_status.state, 'disconnected');
  }
);
