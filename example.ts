import { SSHTunnel } from './src/index';

(async function () {
  const some_tunnel_username = process.env.SOME_TUNNEL_USERNAME ?? '';
  const some_tunnel_password = process.env.SOME_TUNNEL_PASSWORD ?? '';

  const local_service_socket_path = `/tmp/sshtunnel_local_service_${process.pid}.sock`;

  // This class holds and manages multiple tunnel runtimes.
  const ssh_tunnels = new SSHTunnel();

  ssh_tunnels.on('reconnecting', (event_payload) => {
    console.log('reconnecting event:', event_payload);
  });

  ssh_tunnels.on('forward_established', (event_payload) => {
    console.log('forward established event:', event_payload);
  });

  ssh_tunnels.on('forward_failed', (event_payload) => {
    console.error('forward failed event:', event_payload);
  });

  // Legacy TCP mapping style (backward-compatible).
  ssh_tunnels.defineTunnel({
    name: 'legacy_tcp_tunnel',
    host: 'some_hostname_or_ip_address.com',
    port: 22,
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
    ],
    reconnect_strategy: {
      enabled: true,
      base_interval_ms: 1000,
      max_interval_ms: 30000,
      max_attempts: 'infinite',
      jitter_ratio: 0.2
    },
    auth: {
      username: some_tunnel_username,
      password: some_tunnel_password
    }
  });

  // Endpoint mapping style supports mixed TCP/UNIX socket forwarding.
  ssh_tunnels.defineTunnel({
    name: 'mixed_endpoint_tunnel',
    host: 'some_hostname_or_ip_address.com',
    port: 22,
    local_to_remote_endpoint_mappings: [
      {
        local_endpoint: {
          endpoint_type: 'tcp',
          tcp_port: 5555
        },
        remote_endpoint: {
          endpoint_type: 'unix_socket',
          socket_path: '/run/gvm/gvmd.sock'
        }
      },
      {
        local_endpoint: {
          endpoint_type: 'unix_socket',
          socket_path: local_service_socket_path
        },
        remote_endpoint: {
          endpoint_type: 'tcp',
          tcp_port: 6666,
          bind_address: '127.0.0.1'
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
          tcp_port: 9999,
          bind_address: '127.0.0.1'
        }
      },
      {
        remote_endpoint: {
          endpoint_type: 'tcp',
          tcp_port: 10000,
          bind_address: '127.0.0.1'
        },
        local_endpoint: {
          endpoint_type: 'unix_socket',
          socket_path: '/tmp/sshtunnel_remote_incoming.sock'
        }
      }
    ],
    reconnect_strategy: {
      enabled: true,
      base_interval_ms: 1000,
      max_interval_ms: 30000,
      max_attempts: 'infinite',
      jitter_ratio: 0.2
    },
    auth: {
      username: some_tunnel_username,
      password: some_tunnel_password
    }
  });

  // This attempts to establish all defined tunnels.
  const tunnel_establishment_info = await ssh_tunnels.establishTunnels();
  console.log('tunnel_establishment_info:', tunnel_establishment_info);

  // This returns current state, mappings, and reconnect metadata for each tunnel.
  const tunnel_status_info = await ssh_tunnels.tunnelStatus();
  console.log('tunnel_status_info:', tunnel_status_info);
})();
