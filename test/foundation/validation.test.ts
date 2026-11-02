import assert from 'node:assert';
import test from 'node:test';

import { SSHTunnelError, ValidateTunnelDefinition, ValidateTunnelDefinitions } from '@src/index';

const valid_definition = {
  name: 'alpha_tunnel',
  host: '127.0.0.1',
  port: 22,
  local_to_remote_port_mappings: [
    {
      local_tcp_port: 3001,
      remote_tcp_port: 4001
    }
  ],
  remote_to_local_port_mappings: [],
  auth: {
    username: 'some_user',
    password: 'some_password'
  }
};

test('ValidateTunnelDefinition accepts a valid password-auth tunnel definition.', async function () {
  const parsed = ValidateTunnelDefinition({
    tunnel_definition: valid_definition
  });

  assert.strictEqual(parsed.name, 'alpha_tunnel');
  assert.strictEqual(parsed.auth.username, 'some_user');
});

test('ValidateTunnelDefinitions rejects duplicate tunnel names.', async function () {
  assert.throws(
    function () {
      ValidateTunnelDefinitions({
        tunnel_definitions: [
          valid_definition,
          {
            ...valid_definition,
            host: '10.0.0.2'
          }
        ]
      });
    },
    function (error: unknown) {
      assert(error instanceof SSHTunnelError);
      assert.strictEqual(error.code, 'duplicate_tunnel_name');
      return true;
    }
  );
});

test('ValidateTunnelDefinitions rejects local bind port conflicts across tunnels.', async function () {
  assert.throws(
    function () {
      ValidateTunnelDefinitions({
        tunnel_definitions: [
          valid_definition,
          {
            ...valid_definition,
            name: 'beta_tunnel'
          }
        ]
      });
    },
    function (error: unknown) {
      assert(error instanceof SSHTunnelError);
      assert.strictEqual(error.code, 'local_port_conflict');
      return true;
    }
  );
});

test('ValidateTunnelDefinition normalizes legacy TCP mappings into endpoint mappings.', async function () {
  const parsed = ValidateTunnelDefinition({
    tunnel_definition: valid_definition
  });

  assert.strictEqual(parsed.local_to_remote_endpoint_mappings?.length, 1);
  assert.strictEqual(parsed.remote_to_local_endpoint_mappings?.length, 0);
  assert.strictEqual(
    parsed.local_to_remote_endpoint_mappings?.[0]?.local_endpoint.endpoint_type,
    'tcp'
  );
  assert.strictEqual(
    parsed.local_to_remote_endpoint_mappings?.[0]?.remote_endpoint.endpoint_type,
    'tcp'
  );
});

test('ValidateTunnelDefinition accepts endpoint-based TCP mappings and derives legacy mappings.', async function () {
  const parsed = ValidateTunnelDefinition({
    tunnel_definition: {
      name: 'endpoint_tcp_tunnel',
      host: '127.0.0.1',
      port: 22,
      local_to_remote_endpoint_mappings: [
        {
          local_endpoint: {
            endpoint_type: 'tcp',
            tcp_port: 3301
          },
          remote_endpoint: {
            endpoint_type: 'tcp',
            tcp_port: 4401
          }
        }
      ],
      remote_to_local_endpoint_mappings: [
        {
          remote_endpoint: {
            endpoint_type: 'tcp',
            tcp_port: 7701
          },
          local_endpoint: {
            endpoint_type: 'tcp',
            tcp_port: 8801
          }
        }
      ],
      auth: {
        username: 'some_user',
        password: 'some_password'
      }
    }
  });

  assert.strictEqual(parsed.local_to_remote_port_mappings.length, 1);
  assert.strictEqual(parsed.local_to_remote_port_mappings[0]?.local_tcp_port, 3301);
  assert.strictEqual(parsed.local_to_remote_port_mappings[0]?.remote_tcp_port, 4401);
  assert.strictEqual(parsed.remote_to_local_port_mappings.length, 1);
  assert.strictEqual(parsed.remote_to_local_port_mappings[0]?.remote_tcp_port, 7701);
  assert.strictEqual(parsed.remote_to_local_port_mappings[0]?.local_tcp_port, 8801);
});

test('ValidateTunnelDefinition accepts UNIX endpoint mappings while preserving legacy compatibility fields.', async function () {
  const parsed = ValidateTunnelDefinition({
    tunnel_definition: {
      name: 'endpoint_unix_tunnel',
      host: '127.0.0.1',
      port: 22,
      local_to_remote_endpoint_mappings: [
        {
          local_endpoint: {
            endpoint_type: 'unix_socket',
            socket_path: '/tmp/local.sock'
          },
          remote_endpoint: {
            endpoint_type: 'unix_socket',
            socket_path: '/run/gvm/gvmd.sock'
          }
        }
      ],
      auth: {
        username: 'some_user',
        password: 'some_password'
      }
    }
  });

  assert.strictEqual(parsed.local_to_remote_endpoint_mappings?.length, 1);
  assert.strictEqual(parsed.remote_to_local_endpoint_mappings?.length, 0);
  assert.strictEqual(parsed.local_to_remote_port_mappings.length, 0);
  assert.strictEqual(parsed.remote_to_local_port_mappings.length, 0);
});

test('ValidateTunnelDefinition accepts mixed endpoint mapping pairs.', async function () {
  const parsed = ValidateTunnelDefinition({
    tunnel_definition: {
      name: 'mixed_endpoints_tunnel',
      host: '127.0.0.1',
      port: 22,
      local_to_remote_endpoint_mappings: [
        {
          local_endpoint: {
            endpoint_type: 'tcp',
            tcp_port: 3399
          },
          remote_endpoint: {
            endpoint_type: 'unix_socket',
            socket_path: '/run/gvm/gvmd.sock'
          }
        },
        {
          local_endpoint: {
            endpoint_type: 'unix_socket',
            socket_path: '/tmp/local_listener.sock'
          },
          remote_endpoint: {
            endpoint_type: 'tcp',
            tcp_port: 4499
          }
        }
      ],
      auth: {
        username: 'some_user',
        password: 'some_password'
      }
    }
  });

  assert.strictEqual(parsed.local_to_remote_endpoint_mappings?.length, 2);
  assert.strictEqual(parsed.local_to_remote_port_mappings.length, 0);
  assert.strictEqual(parsed.remote_to_local_port_mappings.length, 0);
});

test('ValidateTunnelDefinition rejects non-absolute UNIX socket paths.', async function () {
  assert.throws(
    function () {
      ValidateTunnelDefinition({
        tunnel_definition: {
          name: 'relative_socket_path',
          host: '127.0.0.1',
          port: 22,
          local_to_remote_endpoint_mappings: [
            {
              local_endpoint: {
                endpoint_type: 'unix_socket',
                socket_path: 'relative/path.sock'
              },
              remote_endpoint: {
                endpoint_type: 'tcp',
                tcp_port: 4500
              }
            }
          ],
          auth: {
            username: 'some_user',
            password: 'some_password'
          }
        }
      });
    },
    function (error: unknown) {
      assert(error instanceof SSHTunnelError);
      assert.strictEqual(error.code, 'validation_error');
      return true;
    }
  );
});

test('ValidateTunnelDefinitions rejects local UNIX socket path conflicts across tunnels.', async function () {
  assert.throws(
    function () {
      ValidateTunnelDefinitions({
        tunnel_definitions: [
          {
            name: 'unix_alpha',
            host: '127.0.0.1',
            port: 22,
            local_to_remote_endpoint_mappings: [
              {
                local_endpoint: {
                  endpoint_type: 'unix_socket',
                  socket_path: '/tmp/shared.sock'
                },
                remote_endpoint: {
                  endpoint_type: 'tcp',
                  tcp_port: 6101
                }
              }
            ],
            auth: {
              username: 'some_user',
              password: 'some_password'
            }
          },
          {
            name: 'unix_beta',
            host: '127.0.0.1',
            port: 22,
            remote_to_local_endpoint_mappings: [
              {
                remote_endpoint: {
                  endpoint_type: 'tcp',
                  tcp_port: 6201
                },
                local_endpoint: {
                  endpoint_type: 'unix_socket',
                  socket_path: '/tmp/shared.sock'
                }
              }
            ],
            auth: {
              username: 'some_user',
              password: 'some_password'
            }
          }
        ]
      });
    },
    function (error: unknown) {
      assert(error instanceof SSHTunnelError);
      assert.strictEqual(error.code, 'local_socket_path_conflict');
      return true;
    }
  );
});

test('ValidateTunnelDefinitions rejects local TCP conflicts from mixed endpoint mappings.', async function () {
  assert.throws(
    function () {
      ValidateTunnelDefinitions({
        tunnel_definitions: [
          {
            name: 'mixed_tcp_alpha',
            host: '127.0.0.1',
            port: 22,
            local_to_remote_endpoint_mappings: [
              {
                local_endpoint: {
                  endpoint_type: 'tcp',
                  tcp_port: 6111
                },
                remote_endpoint: {
                  endpoint_type: 'unix_socket',
                  socket_path: '/run/service_alpha.sock'
                }
              }
            ],
            auth: {
              username: 'some_user',
              password: 'some_password'
            }
          },
          {
            name: 'mixed_tcp_beta',
            host: '127.0.0.1',
            port: 22,
            remote_to_local_endpoint_mappings: [
              {
                remote_endpoint: {
                  endpoint_type: 'unix_socket',
                  socket_path: '/run/service_beta.sock'
                },
                local_endpoint: {
                  endpoint_type: 'tcp',
                  tcp_port: 6111
                }
              }
            ],
            auth: {
              username: 'some_user',
              password: 'some_password'
            }
          }
        ]
      });
    },
    function (error: unknown) {
      assert(error instanceof SSHTunnelError);
      assert.strictEqual(error.code, 'local_port_conflict');
      return true;
    }
  );
});
