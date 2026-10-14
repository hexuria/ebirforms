import { describe, expect, test } from 'bun:test'
import { describeSftpConfig, loadSftpConfig } from '../src/env.js'

describe('loadSftpConfig', () => {
  test('defaults to dry-run when unset', () => {
    expect(loadSftpConfig({})).toEqual({ mode: 'dry-run' })
  })

  test('stays in dry-run when live mode is not exactly enabled', () => {
    expect(loadSftpConfig({ BIR_SFTP_LIVE: '0', BIR_SFTP_HOST: 'example.test' })).toEqual({
      mode: 'dry-run',
    })
  })

  test('uses the default port for direct live mode', () => {
    expect(
      loadSftpConfig({
        BIR_SFTP_LIVE: '1',
        BIR_SFTP_HOST: 'example.test',
        BIR_SFTP_USERNAME: 'user',
        BIR_SFTP_PASSWORD: 'secret',
      }),
    ).toEqual({
      mode: 'live-direct',
      host: 'example.test',
      port: 22,
      username: 'user',
      password: 'secret',
    })
  })

  test('uses an explicitly configured port', () => {
    expect(
      loadSftpConfig({
        BIR_SFTP_LIVE: '1',
        BIR_SFTP_HOST: 'example.test',
        BIR_SFTP_PORT: '2022',
        BIR_SFTP_USERNAME: 'user',
        BIR_SFTP_PASSWORD: 'secret',
      }),
    ).toMatchObject({ mode: 'live-direct', port: 2022 })
  })

  test('rejects ports outside the integer range', () => {
    for (const BIR_SFTP_PORT of ['0', '65536', '22.5', 'not-a-port']) {
      expect(() =>
        loadSftpConfig({
          BIR_SFTP_LIVE: '1',
          BIR_SFTP_HOST: 'example.test',
          BIR_SFTP_PORT,
          BIR_SFTP_USERNAME: 'user',
          BIR_SFTP_PASSWORD: 'secret',
        }),
      ).toThrow('BIR_SFTP_PORT')
    }
  })

  test('requires username and password for direct live mode', () => {
    const directConfig = {
      BIR_SFTP_LIVE: '1',
      BIR_SFTP_HOST: 'example.test',
    }

    expect(() => loadSftpConfig(directConfig)).toThrow('BIR_SFTP_USERNAME')
    expect(() => loadSftpConfig({ ...directConfig, BIR_SFTP_USERNAME: 'user' })).toThrow(
      'BIR_SFTP_PASSWORD',
    )
  })

  test('uses the dispatcher when live mode has no host', () => {
    expect(loadSftpConfig({ BIR_SFTP_LIVE: '1' })).toEqual({ mode: 'live-dispatcher' })
  })

  test('preserves the password exactly as given', () => {
    expect(
      loadSftpConfig({
        BIR_SFTP_LIVE: '1',
        BIR_SFTP_HOST: 'example.test',
        BIR_SFTP_USERNAME: 'user',
        BIR_SFTP_PASSWORD: 'secret==',
      }),
    ).toMatchObject({ mode: 'live-direct', password: 'secret==' })
  })

  test('never includes the password in the description', () => {
    const password = 'do-not-log-this=='
    expect(
      describeSftpConfig({
        mode: 'live-direct',
        host: 'example.test',
        port: 22,
        username: 'user',
        password,
      }),
    ).not.toContain(password)
  })
})
