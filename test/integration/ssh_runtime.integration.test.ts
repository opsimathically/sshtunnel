import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import test from 'node:test';

import { SSHTunnelRuntime, type tunnel_definition_t } from '@src/index';

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

function BuildIntegrationTunnelDefinition(params: {
  local_tcp_port: number;
}): tunnel_definition_t {
  const ssh_host = process.env.SSH_TUNNEL_INTEGRATION_HOST;
  const ssh_port_raw = process.env.SSH_TUNNEL_INTEGRATION_PORT;
  const ssh_username = process.env.SSH_TUNNEL_INTEGRATION_USERNAME;

  if (ssh_host === undefined || ssh_host.trim() === '') {
    throw new Error('Missing SSH_TUNNEL_INTEGRATION_HOST.');
  }

  if (ssh_username === undefined || ssh_username.trim() === '') {
    throw new Error('Missing SSH_TUNNEL_INTEGRATION_USERNAME.');
  }

  const ssh_port = ssh_port_raw !== undefined ? Number(ssh_port_raw) : 22;

  const ssh_password = process.env.SSH_TUNNEL_INTEGRATION_PASSWORD;
  const ssh_private_key = process.env.SSH_TUNNEL_INTEGRATION_PRIVATE_KEY;
  const ssh_private_key_path = process.env.SSH_TUNNEL_INTEGRATION_PRIVATE_KEY_PATH;

  let auth: tunnel_definition_t['auth'];

  if (ssh_password !== undefined && ssh_password !== '') {
    auth = {
      username: ssh_username,
      password: ssh_password
    };
  } else if (ssh_private_key !== undefined && ssh_private_key !== '') {
    auth = {
      username: ssh_username,
      private_key: ssh_private_key,
      passphrase: process.env.SSH_TUNNEL_INTEGRATION_PRIVATE_KEY_PASSPHRASE
    };
  } else if (ssh_private_key_path !== undefined && ssh_private_key_path !== '') {
    auth = {
      username: ssh_username,
      private_key: readFileSync(ssh_private_key_path, 'utf8'),
      passphrase: process.env.SSH_TUNNEL_INTEGRATION_PRIVATE_KEY_PASSPHRASE
    };
  } else {
    throw new Error(
      'Missing auth for integration test. Provide SSH_TUNNEL_INTEGRATION_PASSWORD, SSH_TUNNEL_INTEGRATION_PRIVATE_KEY, or SSH_TUNNEL_INTEGRATION_PRIVATE_KEY_PATH.'
    );
  }

  return {
    name: 'integration_runtime_tunnel',
    host: ssh_host,
    port: ssh_port,
    local_to_remote_port_mappings: [
      {
        local_tcp_port: params.local_tcp_port,
        remote_tcp_port: ssh_port,
        remote_bind_address: '127.0.0.1'
      }
    ],
    remote_to_local_port_mappings: [],
    auth
  };
}

test(
  'integration scaffold: runtime can connect and disconnect against a real SSH host.',
  {
    skip:
      process.env.SSH_TUNNEL_INTEGRATION_ENABLED !== 'true'
        ? 'Set SSH_TUNNEL_INTEGRATION_ENABLED=true and integration SSH env vars to run this test.'
        : false
  },
  async function () {

  const local_tcp_port = await GetOpenPort();

  const tunnel_runtime = new SSHTunnelRuntime({
    tunnel_definition: BuildIntegrationTunnelDefinition({
      local_tcp_port
    })
  });

  const connected_status = await tunnel_runtime.connect();
  assert.strictEqual(connected_status.state, 'connected');

  const disconnected_status = await tunnel_runtime.disconnect();
  assert.strictEqual(disconnected_status.state, 'disconnected');
  }
);
