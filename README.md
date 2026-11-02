# sshtunnel

TypeScript library for managing multiple SSH tunnels concurrently, including:

- local-to-remote forwarding
- remote-to-local forwarding
- TCP and UNIX domain socket endpoints
- reconnect with backoff/jitter
- runtime status and typed observability events

## Install

```bash
npm install @opsimathically/sshtunnel
```

## Requirements

- Node.js 20+
- SSH server reachable from the runtime host
- For UNIX socket forwarding (streamlocal): SSH server must support OpenSSH streamlocal forwarding

## Manager API

`SSHTunnel` public API:

- `defineTunnel(...)`
- `establishTunnels()`
- `tunnelStatus()`
- `startTunnel(...)`
- `stopTunnel(...)`
- `restartTunnel(...)`
- `stopAllTunnels()`
- `removeTunnel(...)`

## Forwarding Model

The library supports two mapping styles:

1. Legacy TCP mappings (backward compatible)

```typescript
local_to_remote_port_mappings: [
  {
    local_tcp_port: 3333,
    remote_tcp_port: 4444
  }
],
remote_to_local_port_mappings: [
  {
    remote_tcp_port: 7777,
    local_tcp_port: 8888
  }
]
```

2. Endpoint mappings (TCP + UNIX socket)

```typescript
local_to_remote_endpoint_mappings: [
  {
    local_endpoint: {
      endpoint_type: 'tcp',
      tcp_port: 3333
    },
    remote_endpoint: {
      endpoint_type: 'unix_socket',
      socket_path: '/run/gvm/gvmd.sock'
    }
  }
],
remote_to_local_endpoint_mappings: [
  {
    remote_endpoint: {
      endpoint_type: 'unix_socket',
      socket_path: '/run/remote_service.sock'
    },
    local_endpoint: {
      endpoint_type: 'tcp',
      tcp_port: 8888
    }
  }
]
```

Backward compatibility note:

- Existing `local_to_remote_port_mappings` and `remote_to_local_port_mappings` configs remain valid.
- Legacy TCP mappings are normalized into endpoint mappings internally.

## Quick Start

```typescript
import { SSHTunnel } from '@opsimathically/sshtunnel';

(async function () {
  const ssh_tunnels = new SSHTunnel();

  ssh_tunnels.defineTunnel({
    name: 'api_tunnel',
    host: 'example-ssh-host.internal',
    port: 22,
    local_to_remote_endpoint_mappings: [
      {
        local_endpoint: {
          endpoint_type: 'tcp',
          tcp_port: 3000
        },
        remote_endpoint: {
          endpoint_type: 'tcp',
          tcp_port: 8080,
          bind_address: '127.0.0.1'
        }
      }
    ],
    auth: {
      username: process.env.SOME_TUNNEL_USERNAME ?? '',
      password: process.env.SOME_TUNNEL_PASSWORD ?? ''
    }
  });

  const establishment = await ssh_tunnels.establishTunnels();
  console.log(establishment);

  const statuses = await ssh_tunnels.tunnelStatus();
  console.log(statuses);
})();
```

## Authentication

Username/password:

```typescript
auth: {
  username: process.env.SOME_TUNNEL_USERNAME ?? '',
  password: process.env.SOME_TUNNEL_PASSWORD ?? ''
}
```

Private key string:

```typescript
auth: {
  username: process.env.SOME_TUNNEL_USERNAME ?? '',
  private_key: process.env.SOME_TUNNEL_PRIVATE_KEY ?? '',
  passphrase: process.env.SOME_TUNNEL_PRIVATE_KEY_PASSPHRASE
}
```

Private key from file:

```typescript
import { readFileSync } from 'node:fs';

auth: {
  username: process.env.SOME_TUNNEL_USERNAME ?? '',
  private_key: readFileSync('/path/to/id_rsa', 'utf8'),
  passphrase: process.env.SOME_TUNNEL_PRIVATE_KEY_PASSPHRASE
}
```

## Reconnection

Set `reconnect_strategy` per tunnel:

```typescript
reconnect_strategy: {
  enabled: true,
  base_interval_ms: 1000,
  max_interval_ms: 30000,
  max_attempts: 'infinite',
  jitter_ratio: 0.2
}
```

Behavior:

- dropped sessions are detected
- reconnect attempts use bounded exponential backoff with optional jitter
- all mappings are re-established after successful reconnect

Default if omitted:

```typescript
{
  enabled: true,
  base_interval_ms: 1000,
  max_interval_ms: 30000,
  max_attempts: 'infinite',
  jitter_ratio: 0.2
}
```

## Events

`SSHTunnel` re-emits runtime events:

- `connected`
- `disconnected`
- `reconnecting`
- `reconnect_failed`
- `forward_established`
- `forward_failed`

`forward_established` / `forward_failed` payloads include:

- `direction`
- `endpoint_mapping` (always present)
- `mapping` (legacy TCP-only shape, optional)

Example:

```typescript
ssh_tunnels.on('forward_failed', (event_payload) => {
  console.error(event_payload.direction, event_payload.endpoint_mapping);
});
```

## Status

`tunnelStatus()` returns `tunnel_status_i[]` with:

- identity: `name`, `host`, `port`
- lifecycle: `state`
- mappings:
  - `local_to_remote_endpoint_mappings`
  - `remote_to_local_endpoint_mappings`
  - legacy compatibility fields:
    - `local_to_remote_port_mappings`
    - `remote_to_local_port_mappings`
- reconnect metadata: `reconnect_attempt_count`, `reconnect_info`
- timing: `established_at_iso_8601`, `disconnected_at_iso_8601`, `updated_at_iso_8601`
- `last_error_message`

## Streamlocal Requirements (UNIX Socket Forwarding)

For remote UNIX socket forwarding to work:

- remote SSH daemon must support streamlocal forwarding (OpenSSH extension)
- server policy must allow streamlocal forwarding
- remote user must have filesystem permission to create/use the target socket path

If streamlocal support is unavailable, runtime throws `SSHTunnelError` with code `forwarding_error`.

## Limitations and Platform Notes

- UNIX socket path length is platform-limited (commonly ~107 bytes on Linux/macOS); long paths fail validation at runtime.
- Local UNIX socket parent directory must exist.
- Local stale socket files are cleaned up before binding and on disconnect.
- TCP bind conflicts and local UNIX socket path conflicts are detected across defined tunnels.

## Integration Test Scaffolds

Both integration tests are skipped by default.

1. Basic SSH connect/disconnect scaffold

Set:

- `SSH_TUNNEL_INTEGRATION_ENABLED=true`
- `SSH_TUNNEL_INTEGRATION_HOST`
- `SSH_TUNNEL_INTEGRATION_USERNAME`
- one auth option:
  - `SSH_TUNNEL_INTEGRATION_PASSWORD`, or
  - `SSH_TUNNEL_INTEGRATION_PRIVATE_KEY`, or
  - `SSH_TUNNEL_INTEGRATION_PRIVATE_KEY_PATH`

Optional:

- `SSH_TUNNEL_INTEGRATION_PORT` (default `22`)
- `SSH_TUNNEL_INTEGRATION_PRIVATE_KEY_PASSPHRASE`

2. Streamlocal UNIX forwarding scaffold

Set all values above, plus:

- `SSH_TUNNEL_STREAMLOCAL_INTEGRATION_ENABLED=true`

Optional:

- `SSH_TUNNEL_STREAMLOCAL_REMOTE_SOCKET_PATH`

## Error Handling

Errors are `SSHTunnelError` with typed codes, including:

- `validation_error`
- `duplicate_tunnel_name`
- `local_port_conflict`
- `local_socket_path_conflict`
- `tunnel_not_found`
- `connection_error`
- `forwarding_error`
- `dependency_missing`
- `internal_error`

## Development

```bash
npm run typecheck
npm test
npm run lint
npm run build
```

## Documentation

```bash
npm run docs
```
