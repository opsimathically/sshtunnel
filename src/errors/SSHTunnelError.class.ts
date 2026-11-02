export type ssh_tunnel_error_code_t =
  | 'validation_error'
  | 'duplicate_tunnel_name'
  | 'local_port_conflict'
  | 'local_socket_path_conflict'
  | 'not_implemented'
  | 'tunnel_not_found'
  | 'connection_error'
  | 'forwarding_error'
  | 'dependency_missing'
  | 'internal_error';

export type ssh_tunnel_error_context_t = Record<string, unknown>;

export class SSHTunnelError extends Error {
  public readonly code: ssh_tunnel_error_code_t;
  public readonly context?: ssh_tunnel_error_context_t;

  constructor(params: {
    message: string;
    code: ssh_tunnel_error_code_t;
    context?: ssh_tunnel_error_context_t;
  }) {
    super(params.message);
    this.name = 'SSHTunnelError';
    this.code = params.code;
    if (params.context !== undefined) {
      this.context = params.context;
    }
  }
}

export class TunnelDefinitionValidationError extends SSHTunnelError {
  constructor(params: {
    message: string;
    context?: ssh_tunnel_error_context_t;
  }) {
    const error_params: {
      message: string;
      code: ssh_tunnel_error_code_t;
      context?: ssh_tunnel_error_context_t;
    } = {
      message: params.message,
      code: 'validation_error'
    };

    if (params.context !== undefined) {
      error_params.context = params.context;
    }

    super(error_params);
    this.name = 'TunnelDefinitionValidationError';
  }
}

export function CreateNotImplementedError(params: {
  method_name: string;
}): SSHTunnelError {
  return new SSHTunnelError({
    message: `${params.method_name} is not implemented yet.`,
    code: 'not_implemented',
    context: {
      method_name: params.method_name
    }
  });
}
