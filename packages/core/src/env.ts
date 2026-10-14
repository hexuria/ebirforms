export type SftpConfig =
  | { mode: 'dry-run' }
  | { mode: 'live-direct'; host: string; port: number; username: string; password: string }
  | { mode: 'live-dispatcher' }

export function loadSftpConfig(
  env: Record<string, string | undefined> = process.env,
): SftpConfig {
  if (env.BIR_SFTP_LIVE !== '1') {
    return { mode: 'dry-run' }
  }

  const host = env.BIR_SFTP_HOST
  if (!host) {
    return { mode: 'live-dispatcher' }
  }

  const portValue = env.BIR_SFTP_PORT ?? '22'
  const port = Number(portValue)
  if (!/^\d+$/.test(portValue) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('BIR_SFTP_PORT must be an integer between 1 and 65535.')
  }

  const username = env.BIR_SFTP_USERNAME
  if (!username) {
    throw new Error('BIR_SFTP_USERNAME is required for direct SFTP mode.')
  }

  const password = env.BIR_SFTP_PASSWORD
  if (password === undefined || password.length === 0) {
    throw new Error('BIR_SFTP_PASSWORD is required for direct SFTP mode.')
  }

  return { mode: 'live-direct', host, port, username, password }
}

export function describeSftpConfig(config: SftpConfig): string {
  switch (config.mode) {
    case 'dry-run':
      return 'SFTP: dry run'
    case 'live-direct':
      return `SFTP: live direct (${config.host}:${config.port})`
    case 'live-dispatcher':
      return 'SFTP: live dispatcher'
  }
}
