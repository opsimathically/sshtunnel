import { z } from 'zod';

import {
  TunnelDefinitionValidationError,
  SSHTunnelError
} from '@src/errors/SSHTunnelError.class';
import type {
  local_to_remote_endpoint_mapping_t,
  local_to_remote_port_mapping_t,
  reconnect_strategy_t,
  remote_to_local_endpoint_mapping_t,
  remote_to_local_port_mapping_t,
  ssh_auth_t,
  tcp_endpoint_t,
  tunnel_definition_input_t,
  tunnel_definition_t,
  tunnel_endpoint_t,
  unix_socket_endpoint_t
} from '@src/types/ssh_tunnel.types';

const tcp_port_schema = z.number().int().min(1).max(65535);
const optional_bind_address_schema = z.string().trim().min(1).optional();
const unix_socket_path_schema = z
  .string()
  .trim()
  .min(1)
  .refine((socket_path) => socket_path.startsWith('/'), {
    message: 'UNIX socket paths must be absolute paths.'
  })
  .refine((socket_path) => !socket_path.includes('\u0000'), {
    message: 'UNIX socket paths must not contain null bytes.'
  });

export const local_to_remote_port_mapping_schema: z.ZodType<local_to_remote_port_mapping_t> =
  z
    .object({
      local_tcp_port: tcp_port_schema,
      remote_tcp_port: tcp_port_schema,
      local_bind_address: optional_bind_address_schema,
      remote_bind_address: optional_bind_address_schema
    })
    .strict();

export const remote_to_local_port_mapping_schema: z.ZodType<remote_to_local_port_mapping_t> =
  z
    .object({
      remote_tcp_port: tcp_port_schema,
      local_tcp_port: tcp_port_schema,
      remote_bind_address: optional_bind_address_schema,
      local_bind_address: optional_bind_address_schema
    })
    .strict();

export const tcp_endpoint_schema: z.ZodType<tcp_endpoint_t> = z
  .object({
    endpoint_type: z.literal('tcp'),
    tcp_port: tcp_port_schema,
    bind_address: optional_bind_address_schema
  })
  .strict();

export const unix_socket_endpoint_schema: z.ZodType<unix_socket_endpoint_t> = z
  .object({
    endpoint_type: z.literal('unix_socket'),
    socket_path: unix_socket_path_schema
  })
  .strict();

export const tunnel_endpoint_schema: z.ZodType<tunnel_endpoint_t> = z.union([
  tcp_endpoint_schema,
  unix_socket_endpoint_schema
]);

export const local_to_remote_endpoint_mapping_schema: z.ZodType<local_to_remote_endpoint_mapping_t> =
  z
    .object({
      local_endpoint: tunnel_endpoint_schema,
      remote_endpoint: tunnel_endpoint_schema
    })
    .strict();

export const remote_to_local_endpoint_mapping_schema: z.ZodType<remote_to_local_endpoint_mapping_t> =
  z
    .object({
      remote_endpoint: tunnel_endpoint_schema,
      local_endpoint: tunnel_endpoint_schema
    })
    .strict();

const username_password_auth_schema = z
  .object({
    username: z.string().trim().min(1),
    password: z.string().min(1),
    auth_type: z.literal('username_password').optional()
  })
  .strict();

const private_key_auth_schema = z
  .object({
    username: z.string().trim().min(1),
    private_key: z.union([z.string().min(1), z.instanceof(Buffer)]),
    passphrase: z.string().optional(),
    auth_type: z.literal('private_key').optional()
  })
  .strict();

export const ssh_auth_schema: z.ZodType<ssh_auth_t> = z.union([
  username_password_auth_schema,
  private_key_auth_schema
]);

export const reconnect_strategy_schema: z.ZodType<reconnect_strategy_t> = z
  .object({
    enabled: z.boolean(),
    base_interval_ms: z.number().int().positive(),
    max_interval_ms: z.number().int().positive(),
    max_attempts: z.union([z.number().int().nonnegative(), z.literal('infinite')]),
    jitter_ratio: z.number().min(0).max(1)
  })
  .strict()
  .refine((value) => value.max_interval_ms >= value.base_interval_ms, {
    message: 'max_interval_ms must be greater than or equal to base_interval_ms.'
  });

export const tunnel_definition_input_schema: z.ZodType<tunnel_definition_input_t> = z
  .object({
    name: z.string().trim().min(1),
    host: z.string().trim().min(1),
    port: tcp_port_schema,
    ready_timeout_ms: z.number().int().positive().optional(),
    keepalive_interval_ms: z.number().int().positive().optional(),
    keepalive_count_max: z.number().int().nonnegative().optional(),
    local_to_remote_port_mappings: z.array(local_to_remote_port_mapping_schema).optional(),
    remote_to_local_port_mappings: z.array(remote_to_local_port_mapping_schema).optional(),
    local_to_remote_endpoint_mappings: z
      .array(local_to_remote_endpoint_mapping_schema)
      .optional(),
    remote_to_local_endpoint_mappings: z
      .array(remote_to_local_endpoint_mapping_schema)
      .optional(),
    reconnect_strategy: reconnect_strategy_schema.optional(),
    auth: ssh_auth_schema
  })
  .strict()
  .refine(
    (value) =>
      (value.local_to_remote_port_mappings?.length ?? 0) > 0 ||
      (value.remote_to_local_port_mappings?.length ?? 0) > 0 ||
      (value.local_to_remote_endpoint_mappings?.length ?? 0) > 0 ||
      (value.remote_to_local_endpoint_mappings?.length ?? 0) > 0,
    {
      message:
        'At least one mapping is required in legacy port mappings or endpoint mappings.'
    }
  );

export const tunnel_definition_schema: z.ZodType<tunnel_definition_input_t> =
  tunnel_definition_input_schema;

function ConvertLocalToRemotePortMappingToEndpointMapping(params: {
  mapping: local_to_remote_port_mapping_t;
}): local_to_remote_endpoint_mapping_t {
  return {
    local_endpoint: {
      endpoint_type: 'tcp',
      tcp_port: params.mapping.local_tcp_port,
      bind_address: params.mapping.local_bind_address
    },
    remote_endpoint: {
      endpoint_type: 'tcp',
      tcp_port: params.mapping.remote_tcp_port,
      bind_address: params.mapping.remote_bind_address
    }
  };
}

function ConvertRemoteToLocalPortMappingToEndpointMapping(params: {
  mapping: remote_to_local_port_mapping_t;
}): remote_to_local_endpoint_mapping_t {
  return {
    remote_endpoint: {
      endpoint_type: 'tcp',
      tcp_port: params.mapping.remote_tcp_port,
      bind_address: params.mapping.remote_bind_address
    },
    local_endpoint: {
      endpoint_type: 'tcp',
      tcp_port: params.mapping.local_tcp_port,
      bind_address: params.mapping.local_bind_address
    }
  };
}

function ConvertLocalToRemoteEndpointMappingToLegacyPortMapping(params: {
  mapping: local_to_remote_endpoint_mapping_t;
}): local_to_remote_port_mapping_t | undefined {
  if (
    params.mapping.local_endpoint.endpoint_type !== 'tcp' ||
    params.mapping.remote_endpoint.endpoint_type !== 'tcp'
  ) {
    return undefined;
  }

  return {
    local_tcp_port: params.mapping.local_endpoint.tcp_port,
    remote_tcp_port: params.mapping.remote_endpoint.tcp_port,
    local_bind_address: params.mapping.local_endpoint.bind_address,
    remote_bind_address: params.mapping.remote_endpoint.bind_address
  };
}

function ConvertRemoteToLocalEndpointMappingToLegacyPortMapping(params: {
  mapping: remote_to_local_endpoint_mapping_t;
}): remote_to_local_port_mapping_t | undefined {
  if (
    params.mapping.remote_endpoint.endpoint_type !== 'tcp' ||
    params.mapping.local_endpoint.endpoint_type !== 'tcp'
  ) {
    return undefined;
  }

  return {
    remote_tcp_port: params.mapping.remote_endpoint.tcp_port,
    local_tcp_port: params.mapping.local_endpoint.tcp_port,
    remote_bind_address: params.mapping.remote_endpoint.bind_address,
    local_bind_address: params.mapping.local_endpoint.bind_address
  };
}

function DeduplicateLocalToRemotePortMappings(params: {
  mappings: local_to_remote_port_mapping_t[];
}): local_to_remote_port_mapping_t[] {
  const mapping_by_key = new Map<string, local_to_remote_port_mapping_t>();

  for (const mapping of params.mappings) {
    const mapping_key = `${mapping.local_bind_address ?? ''}|${mapping.local_tcp_port}|${mapping.remote_bind_address ?? ''}|${mapping.remote_tcp_port}`;
    mapping_by_key.set(mapping_key, mapping);
  }

  return [...mapping_by_key.values()];
}

function DeduplicateRemoteToLocalPortMappings(params: {
  mappings: remote_to_local_port_mapping_t[];
}): remote_to_local_port_mapping_t[] {
  const mapping_by_key = new Map<string, remote_to_local_port_mapping_t>();

  for (const mapping of params.mappings) {
    const mapping_key = `${mapping.remote_bind_address ?? ''}|${mapping.remote_tcp_port}|${mapping.local_bind_address ?? ''}|${mapping.local_tcp_port}`;
    mapping_by_key.set(mapping_key, mapping);
  }

  return [...mapping_by_key.values()];
}

function DeduplicateLocalToRemoteEndpointMappings(params: {
  mappings: local_to_remote_endpoint_mapping_t[];
}): local_to_remote_endpoint_mapping_t[] {
  const mapping_by_key = new Map<string, local_to_remote_endpoint_mapping_t>();

  for (const mapping of params.mappings) {
    const mapping_key = JSON.stringify(mapping);
    mapping_by_key.set(mapping_key, mapping);
  }

  return [...mapping_by_key.values()];
}

function DeduplicateRemoteToLocalEndpointMappings(params: {
  mappings: remote_to_local_endpoint_mapping_t[];
}): remote_to_local_endpoint_mapping_t[] {
  const mapping_by_key = new Map<string, remote_to_local_endpoint_mapping_t>();

  for (const mapping of params.mappings) {
    const mapping_key = JSON.stringify(mapping);
    mapping_by_key.set(mapping_key, mapping);
  }

  return [...mapping_by_key.values()];
}

export function NormalizeTunnelDefinitionInput(params: {
  tunnel_definition_input: tunnel_definition_input_t;
}): tunnel_definition_t {
  const local_to_remote_port_mappings =
    params.tunnel_definition_input.local_to_remote_port_mappings ?? [];
  const remote_to_local_port_mappings =
    params.tunnel_definition_input.remote_to_local_port_mappings ?? [];

  const local_to_remote_endpoint_mappings = DeduplicateLocalToRemoteEndpointMappings({
    mappings: [
      ...(params.tunnel_definition_input.local_to_remote_endpoint_mappings ?? []),
      ...local_to_remote_port_mappings.map((mapping) =>
        ConvertLocalToRemotePortMappingToEndpointMapping({ mapping })
      )
    ]
  });

  const remote_to_local_endpoint_mappings = DeduplicateRemoteToLocalEndpointMappings({
    mappings: [
      ...(params.tunnel_definition_input.remote_to_local_endpoint_mappings ?? []),
      ...remote_to_local_port_mappings.map((mapping) =>
        ConvertRemoteToLocalPortMappingToEndpointMapping({ mapping })
      )
    ]
  });

  const endpoint_derived_local_to_remote_port_mappings =
    local_to_remote_endpoint_mappings
      .map((mapping) => ConvertLocalToRemoteEndpointMappingToLegacyPortMapping({ mapping }))
      .filter(
        (mapping): mapping is local_to_remote_port_mapping_t => mapping !== undefined
      );

  const endpoint_derived_remote_to_local_port_mappings =
    remote_to_local_endpoint_mappings
      .map((mapping) => ConvertRemoteToLocalEndpointMappingToLegacyPortMapping({ mapping }))
      .filter(
        (mapping): mapping is remote_to_local_port_mapping_t => mapping !== undefined
      );

  return {
    name: params.tunnel_definition_input.name,
    host: params.tunnel_definition_input.host,
    port: params.tunnel_definition_input.port,
    ready_timeout_ms: params.tunnel_definition_input.ready_timeout_ms,
    keepalive_interval_ms: params.tunnel_definition_input.keepalive_interval_ms,
    keepalive_count_max: params.tunnel_definition_input.keepalive_count_max,
    local_to_remote_port_mappings: DeduplicateLocalToRemotePortMappings({
      mappings: [
        ...local_to_remote_port_mappings,
        ...endpoint_derived_local_to_remote_port_mappings
      ]
    }),
    remote_to_local_port_mappings: DeduplicateRemoteToLocalPortMappings({
      mappings: [
        ...remote_to_local_port_mappings,
        ...endpoint_derived_remote_to_local_port_mappings
      ]
    }),
    local_to_remote_endpoint_mappings,
    remote_to_local_endpoint_mappings,
    reconnect_strategy: params.tunnel_definition_input.reconnect_strategy,
    auth: params.tunnel_definition_input.auth
  };
}

type local_bindings_i = {
  local_tcp_port_set: Set<number>;
  local_unix_socket_path_set: Set<string>;
};

function GetLocalBindings(params: {
  tunnel_definition: tunnel_definition_t;
}): local_bindings_i {
  const local_tcp_port_set = new Set<number>();
  const local_unix_socket_path_set = new Set<string>();

  const local_to_remote_endpoint_mappings =
    params.tunnel_definition.local_to_remote_endpoint_mappings ?? [];
  const remote_to_local_endpoint_mappings =
    params.tunnel_definition.remote_to_local_endpoint_mappings ?? [];

  for (const mapping of local_to_remote_endpoint_mappings) {
    if (mapping.local_endpoint.endpoint_type === 'tcp') {
      local_tcp_port_set.add(mapping.local_endpoint.tcp_port);
      continue;
    }

    local_unix_socket_path_set.add(mapping.local_endpoint.socket_path);
  }

  for (const mapping of remote_to_local_endpoint_mappings) {
    if (mapping.local_endpoint.endpoint_type === 'tcp') {
      local_tcp_port_set.add(mapping.local_endpoint.tcp_port);
      continue;
    }

    local_unix_socket_path_set.add(mapping.local_endpoint.socket_path);
  }

  return {
    local_tcp_port_set,
    local_unix_socket_path_set
  };
}

export function ValidateTunnelDefinition(params: {
  tunnel_definition: unknown;
}): tunnel_definition_t {
  const parsed_definition = tunnel_definition_input_schema.safeParse(
    params.tunnel_definition
  );

  if (!parsed_definition.success) {
    throw new TunnelDefinitionValidationError({
      message: 'Tunnel definition validation failed.',
      context: {
        issues: parsed_definition.error.issues
      }
    });
  }

  return NormalizeTunnelDefinitionInput({
    tunnel_definition_input: parsed_definition.data
  });
}

export function ValidateTunnelDefinitions(params: {
  tunnel_definitions: unknown[];
}): tunnel_definition_t[] {
  const validated_definitions: tunnel_definition_t[] = [];
  const tunnel_name_set = new Set<string>();
  const local_bind_port_to_tunnel_name_map = new Map<number, string>();
  const local_bind_socket_path_to_tunnel_name_map = new Map<string, string>();

  for (const tunnel_definition of params.tunnel_definitions) {
    const validated_definition = ValidateTunnelDefinition({
      tunnel_definition
    });

    if (tunnel_name_set.has(validated_definition.name)) {
      throw new SSHTunnelError({
        message: `Duplicate tunnel name detected: ${validated_definition.name}.`,
        code: 'duplicate_tunnel_name',
        context: {
          tunnel_name: validated_definition.name
        }
      });
    }

    tunnel_name_set.add(validated_definition.name);

    const local_bindings = GetLocalBindings({
      tunnel_definition: validated_definition
    });

    for (const local_bind_port of local_bindings.local_tcp_port_set) {
      const existing_tunnel_name = local_bind_port_to_tunnel_name_map.get(local_bind_port);

      if (existing_tunnel_name !== undefined) {
        throw new SSHTunnelError({
          message: `Local port conflict detected on port ${local_bind_port} between ${existing_tunnel_name} and ${validated_definition.name}.`,
          code: 'local_port_conflict',
          context: {
            local_tcp_port: local_bind_port,
            first_tunnel_name: existing_tunnel_name,
            conflicting_tunnel_name: validated_definition.name
          }
        });
      }

      local_bind_port_to_tunnel_name_map.set(local_bind_port, validated_definition.name);
    }

    for (const local_bind_socket_path of local_bindings.local_unix_socket_path_set) {
      const existing_tunnel_name =
        local_bind_socket_path_to_tunnel_name_map.get(local_bind_socket_path);

      if (existing_tunnel_name !== undefined) {
        throw new SSHTunnelError({
          message: `Local UNIX socket path conflict detected on path ${local_bind_socket_path} between ${existing_tunnel_name} and ${validated_definition.name}.`,
          code: 'local_socket_path_conflict',
          context: {
            local_socket_path: local_bind_socket_path,
            first_tunnel_name: existing_tunnel_name,
            conflicting_tunnel_name: validated_definition.name
          }
        });
      }

      local_bind_socket_path_to_tunnel_name_map.set(
        local_bind_socket_path,
        validated_definition.name
      );
    }

    validated_definitions.push(validated_definition);
  }

  return validated_definitions;
}
