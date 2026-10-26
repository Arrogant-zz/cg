// Тестовые сертификаты для mTLS: CA, сервер 127.0.0.1, клиент и клиент от чужого CA. Создаются openssl во временном каталоге;
// без openssl тесты сертификатов пропускаются. Ключи живут только в каталоге теста и в репозиторий не попадают.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface Pki {
  dir: string;
  ca: string;
  serverCert: string;
  serverKey: string;
  clientCert: string;
  clientKey: string;
  /** Тот же ключ клиента, зашифрованный паролем PASSPHRASE. */
  clientKeyEnc: string;
  /** Сертификат и ключ клиента в PKCS#12 с паролем PASSPHRASE; null, если openssl не смог его собрать. */
  clientPfx: string | null;
  /** Клиент, подписанный другим CA: сервер его не примет. */
  strangerCert: string;
  strangerKey: string;
}

export const PASSPHRASE = 'test-only-passphrase';

export function makePki(dir: string): Pki | null {
  const run = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  try {
    run('version');
  } catch {
    return null;
  }
  const w = (name: string, text: string) => fs.writeFileSync(path.join(dir, name), text);
  const req = (cn: string) => `[req]\ndistinguished_name = dn\nprompt = no\n[dn]\nCN = ${cn}\n`;
  const ca = (name: string, cn: string) => {
    w(`${name}.cnf`, `${req(cn)}[v3_ca]\nbasicConstraints = critical,CA:TRUE\nkeyUsage = critical,keyCertSign,cRLSign\nsubjectKeyIdentifier = hash\n`);
    run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '2', '-keyout', `${name}.key`, '-out', `${name}.crt`, '-config', `${name}.cnf`, '-extensions', 'v3_ca');
  };
  const leaf = (name: string, cn: string, caName: string, ext: string, serial: string) => {
    w(`${name}.cnf`, req(cn));
    w(`${name}.ext`, `[v3]\nbasicConstraints = CA:FALSE\nkeyUsage = critical,digitalSignature,keyEncipherment\n${ext}\n`);
    run('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-config', `${name}.cnf`);
    run('x509', '-req', '-sha256', '-days', '2', '-in', `${name}.csr`, '-CA', `${caName}.crt`, '-CAkey', `${caName}.key`, '-set_serial', serial, '-out', `${name}.crt`, '-extfile', `${name}.ext`, '-extensions', 'v3');
  };
  ca('ca', 'ClawGym Test CA');
  ca('other-ca', 'ClawGym Other Test CA');
  leaf('server', '127.0.0.1', 'ca', 'extendedKeyUsage = serverAuth\nsubjectAltName = IP:127.0.0.1,DNS:localhost', '1001');
  leaf('client', 'clawgym-test-client', 'ca', 'extendedKeyUsage = clientAuth', '1002');
  leaf('stranger', 'clawgym-stranger', 'other-ca', 'extendedKeyUsage = clientAuth', '2001');
  run('pkey', '-in', 'client.key', '-out', 'client-enc.key', '-aes256', '-passout', `pass:${PASSPHRASE}`);
  let pfx: string | null = path.join(dir, 'client.p12');
  try {
    run('pkcs12', '-export', '-out', 'client.p12', '-inkey', 'client.key', '-in', 'client.crt', '-keypbe', 'AES-256-CBC', '-certpbe', 'AES-256-CBC', '-passout', `pass:${PASSPHRASE}`);
  } catch {
    pfx = null;
  }
  const f = (name: string) => path.join(dir, name);
  return {
    dir,
    ca: f('ca.crt'),
    serverCert: f('server.crt'),
    serverKey: f('server.key'),
    clientCert: f('client.crt'),
    clientKey: f('client.key'),
    clientKeyEnc: f('client-enc.key'),
    clientPfx: pfx,
    strangerCert: f('stranger.crt'),
    strangerKey: f('stranger.key'),
  };
}
