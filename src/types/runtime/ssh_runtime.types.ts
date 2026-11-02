import type { Duplex } from 'node:stream';

export type ssh_tcp_connection_details_t = {
  destIP: string;
  destPort: number;
  srcIP: string;
  srcPort: number;
};

export type ssh_unix_connection_details_t = {
  socket_path?: string | undefined;
  socketPath?: string | undefined;
  path?: string | undefined;
};

export type ssh_forward_out_callback_t = (
  error: Error | undefined,
  stream: Duplex | undefined
) => void;

export type ssh_forward_in_callback_t = (error?: Error | undefined) => void;

export type ssh_unforward_in_callback_t = (error?: Error | undefined) => void;

export type ssh_tcp_connection_accept_t = () => Duplex;

export type ssh_tcp_connection_reject_t = () => void;

export type ssh_unix_connection_accept_t = () => Duplex;

export type ssh_unix_connection_reject_t = () => void;

export interface ssh_connect_options_i {
  host: string;
  port: number;
  username: string;
  password?: string | undefined;
  privateKey?: string | Buffer | undefined;
  passphrase?: string | undefined;
  readyTimeout?: number | undefined;
  keepaliveInterval?: number | undefined;
  keepaliveCountMax?: number | undefined;
}

export interface ssh_client_i {
  connect(params: ssh_connect_options_i): void;
  end(): void;
  forwardOut(
    src_ip: string,
    src_port: number,
    dst_ip: string,
    dst_port: number,
    callback: ssh_forward_out_callback_t
  ): void;
  forwardIn(
    bind_address: string,
    bind_port: number,
    callback: ssh_forward_in_callback_t
  ): void;
  openssh_forwardOutStreamLocal?(
    socket_path: string,
    callback: ssh_forward_out_callback_t
  ): void;
  openssh_forwardInStreamLocal?(
    socket_path: string,
    callback: ssh_forward_in_callback_t
  ): void;
  openssh_unforwardInStreamLocal?(
    socket_path: string,
    callback: ssh_unforward_in_callback_t
  ): void;
  unforwardIn(
    bind_address: string,
    bind_port: number,
    callback: ssh_unforward_in_callback_t
  ): void;
  on(event_name: 'ready', listener: () => void): this;
  on(event_name: 'close', listener: (had_error: boolean) => void): this;
  on(event_name: 'end', listener: () => void): this;
  on(event_name: 'error', listener: (error: Error) => void): this;
  on(
    event_name: 'tcp connection',
    listener: (
      details: ssh_tcp_connection_details_t,
      accept: ssh_tcp_connection_accept_t,
      reject: ssh_tcp_connection_reject_t
    ) => void
  ): this;
  on(
    event_name: 'unix connection',
    listener: (
      details: ssh_unix_connection_details_t,
      accept: ssh_unix_connection_accept_t,
      reject: ssh_unix_connection_reject_t
    ) => void
  ): this;
  once(event_name: 'ready', listener: () => void): this;
  once(event_name: 'close', listener: (had_error: boolean) => void): this;
  once(event_name: 'error', listener: (error: Error) => void): this;
  removeAllListeners(event_name?: string): this;
}

export type ssh_client_constructor_t = new () => ssh_client_i;
