import assert from 'node:assert';
import test from 'node:test';

import {
  SSHTunnel,
  SSHTunnelError,
  type tunnel_definition_t,
  type tunnel_runtime_factory_t,
  type tunnel_runtime_i,
  type tunnel_status_i
} from '@src/index';

type fake_runtime_registry_t = {
  failures_by_name: Set<string>;
  instances_by_name: Map<string, FakeTunnelRuntime>;
};

class FakeTunnelRuntime implements tunnel_runtime_i {
  private readonly tunnel_definition: tunnel_definition_t;
  private readonly should_fail_connect: boolean;
  private state: tunnel_status_i['state'];
  private last_error_message: string | undefined;

  constructor(params: {
    tunnel_definition: tunnel_definition_t;
    should_fail_connect: boolean;
  }) {
    this.tunnel_definition = params.tunnel_definition;
    this.should_fail_connect = params.should_fail_connect;
    this.state = 'defined';
    this.last_error_message = undefined;
  }

  async connect(): Promise<tunnel_status_i> {
    if (this.should_fail_connect) {
      this.state = 'failed';
      this.last_error_message = `Failed to connect ${this.tunnel_definition.name}.`;

      throw new SSHTunnelError({
        message: this.last_error_message,
        code: 'connection_error'
      });
    }

    this.state = 'connected';
    this.last_error_message = undefined;
    return this.getStatus();
  }

  async disconnect(): Promise<tunnel_status_i> {
    this.state = 'disconnected';
    return this.getStatus();
  }

  getStatus(): tunnel_status_i {
    return {
      name: this.tunnel_definition.name,
      host: this.tunnel_definition.host,
      port: this.tunnel_definition.port,
      state: this.state,
      local_to_remote_port_mappings: this.tunnel_definition.local_to_remote_port_mappings,
      remote_to_local_port_mappings: this.tunnel_definition.remote_to_local_port_mappings,
      local_to_remote_endpoint_mappings:
        this.tunnel_definition.local_to_remote_endpoint_mappings ?? [],
      remote_to_local_endpoint_mappings:
        this.tunnel_definition.remote_to_local_endpoint_mappings ?? [],
      last_error_message: this.last_error_message,
      reconnect_attempt_count: 0,
      reconnect_info: {
        enabled: true,
        base_interval_ms: 1000,
        max_interval_ms: 30000,
        max_attempts: 'infinite',
        jitter_ratio: 0.2,
        attempt_count: 0
      },
      updated_at_iso_8601: new Date().toISOString()
    };
  }
}

function CreateTunnelDefinition(params: {
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
    remote_to_local_port_mappings: [],
    auth: {
      username: 'some_user',
      password: 'some_password'
    }
  };
}

function CreateManager(params?: {
  fail_connect_for_tunnel_names?: string[];
}): {
  manager: SSHTunnel;
  runtime_registry: fake_runtime_registry_t;
} {
  const runtime_registry: fake_runtime_registry_t = {
    failures_by_name: new Set(params?.fail_connect_for_tunnel_names ?? []),
    instances_by_name: new Map<string, FakeTunnelRuntime>()
  };

  const tunnel_runtime_factory: tunnel_runtime_factory_t = function BuildFakeRuntime(params: {
    tunnel_definition: tunnel_definition_t;
  }): tunnel_runtime_i {
    const runtime = new FakeTunnelRuntime({
      tunnel_definition: params.tunnel_definition,
      should_fail_connect: runtime_registry.failures_by_name.has(params.tunnel_definition.name)
    });

    runtime_registry.instances_by_name.set(params.tunnel_definition.name, runtime);
    return runtime;
  };

  const manager = new SSHTunnel({
    tunnel_runtime_factory
  });

  return {
    manager,
    runtime_registry
  };
}

test('defineTunnel and tunnelStatus report defined tunnel state.', async function () {
  const { manager } = CreateManager();

  manager.defineTunnel(
    CreateTunnelDefinition({
      name: 'alpha',
      local_tcp_port: 41001,
      remote_tcp_port: 42001
    })
  );

  const statuses = await manager.tunnelStatus();

  assert.strictEqual(statuses.length, 1);
  assert.strictEqual(statuses[0]?.name, 'alpha');
  assert.strictEqual(statuses[0]?.state, 'defined');
});

test('defineTunnel accepts endpoint-based mappings and preserves defined state.', async function () {
  const { manager } = CreateManager();

  manager.defineTunnel({
    name: 'endpoint_only',
    host: '127.0.0.1',
    port: 22,
    local_to_remote_endpoint_mappings: [
      {
        local_endpoint: {
          endpoint_type: 'tcp',
          tcp_port: 41040
        },
        remote_endpoint: {
          endpoint_type: 'tcp',
          tcp_port: 42040
        }
      }
    ],
    auth: {
      username: 'some_user',
      password: 'some_password'
    }
  });

  const statuses = await manager.tunnelStatus();
  const endpoint_tunnel_status = statuses.find((status) => status.name === 'endpoint_only');

  assert.notStrictEqual(endpoint_tunnel_status, undefined);
  assert.strictEqual(endpoint_tunnel_status?.state, 'defined');
  assert.strictEqual(endpoint_tunnel_status?.local_to_remote_port_mappings.length, 1);
});

test('defineTunnel rejects duplicate tunnel names.', async function () {
  const { manager } = CreateManager();

  manager.defineTunnel(
    CreateTunnelDefinition({
      name: 'alpha',
      local_tcp_port: 41002,
      remote_tcp_port: 42002
    })
  );

  assert.throws(
    function () {
      manager.defineTunnel(
        CreateTunnelDefinition({
          name: 'alpha',
          local_tcp_port: 41003,
          remote_tcp_port: 42003
        })
      );
    },
    function (error: unknown) {
      assert(error instanceof SSHTunnelError);
      assert.strictEqual(error.code, 'duplicate_tunnel_name');
      return true;
    }
  );
});

test('defineTunnel rejects local bind port conflicts across tunnels.', async function () {
  const { manager } = CreateManager();

  manager.defineTunnel(
    CreateTunnelDefinition({
      name: 'alpha',
      local_tcp_port: 41004,
      remote_tcp_port: 42004
    })
  );

  assert.throws(
    function () {
      manager.defineTunnel(
        CreateTunnelDefinition({
          name: 'beta',
          local_tcp_port: 41004,
          remote_tcp_port: 42005
        })
      );
    },
    function (error: unknown) {
      assert(error instanceof SSHTunnelError);
      assert.strictEqual(error.code, 'local_port_conflict');
      return true;
    }
  );
});

test('establishTunnels handles established, failed, and skipped tunnels.', async function () {
  const { manager } = CreateManager({
    fail_connect_for_tunnel_names: ['gamma']
  });

  manager.defineTunnel(
    CreateTunnelDefinition({
      name: 'alpha',
      local_tcp_port: 41010,
      remote_tcp_port: 42010
    })
  );
  manager.defineTunnel(
    CreateTunnelDefinition({
      name: 'beta',
      local_tcp_port: 41011,
      remote_tcp_port: 42011
    })
  );
  manager.defineTunnel(
    CreateTunnelDefinition({
      name: 'gamma',
      local_tcp_port: 41012,
      remote_tcp_port: 42012
    })
  );

  await manager.startTunnel({ name: 'beta' });

  const result = await manager.establishTunnels();

  assert.strictEqual(result.established_tunnels.includes('alpha'), true);
  assert.strictEqual(result.skipped_tunnels.includes('beta'), true);
  assert.strictEqual(result.failed_tunnels.length, 1);
  assert.strictEqual(result.failed_tunnels[0]?.name, 'gamma');
  assert.strictEqual(result.failed_tunnels[0]?.error_code, 'connection_error');
});

test('startTunnel, stopTunnel, and restartTunnel manage lifecycle by name.', async function () {
  const { manager } = CreateManager();

  manager.defineTunnel(
    CreateTunnelDefinition({
      name: 'alpha',
      local_tcp_port: 41020,
      remote_tcp_port: 42020
    })
  );

  const started_status = await manager.startTunnel({ name: 'alpha' });
  assert.strictEqual(started_status.state, 'connected');

  const restarted_status = await manager.restartTunnel({ name: 'alpha' });
  assert.strictEqual(restarted_status.state, 'connected');

  const stopped_status = await manager.stopTunnel({ name: 'alpha' });
  assert.strictEqual(stopped_status.state, 'disconnected');
});

test('stopAllTunnels and removeTunnel work safely.', async function () {
  const { manager } = CreateManager();

  manager.defineTunnel(
    CreateTunnelDefinition({
      name: 'alpha',
      local_tcp_port: 41030,
      remote_tcp_port: 42030
    })
  );
  manager.defineTunnel(
    CreateTunnelDefinition({
      name: 'beta',
      local_tcp_port: 41031,
      remote_tcp_port: 42031
    })
  );

  await manager.startTunnel({ name: 'alpha' });
  await manager.startTunnel({ name: 'beta' });

  const stopped_statuses = await manager.stopAllTunnels();

  assert.strictEqual(stopped_statuses.length, 2);
  assert.strictEqual(stopped_statuses.every((status) => status.state === 'disconnected'), true);

  await manager.removeTunnel({ name: 'alpha' });

  const remaining_statuses = await manager.tunnelStatus();
  assert.strictEqual(remaining_statuses.length, 1);
  assert.strictEqual(remaining_statuses[0]?.name, 'beta');

  await assert.rejects(async function () {
    await manager.startTunnel({ name: 'alpha' });
  }, function (error: unknown) {
    assert(error instanceof SSHTunnelError);
    assert.strictEqual(error.code, 'tunnel_not_found');
    return true;
  });
});
