// ABR-97: read-only macOS runtime identity discovery through existing,
// strictly host-key-verified SSH. No enrollment, setup or launchd changes.
import { spawn } from 'node:child_process';
import path from 'node:path';

const ALIAS = /^[a-zA-Z0-9_.-]{1,128}$/;
const PYTHON = `import os,platform,pwd,plistlib,json,subprocess
home=os.path.realpath(os.path.expanduser("~"))
label="io.revrebel.agent-bridge"
plist_path=os.path.join(home,"Library","LaunchAgents",label+".plist")
with open(plist_path,"rb") as f: plist=plistlib.load(f)
args=plist.get("ProgramArguments",[])
if len(args)<3 or not args[1].endswith("/linear-agent-bridge/start-bridge.sh"): raise ValueError("UNEXPECTED_LAUNCHD_ENTRYPOINT")
script=os.path.realpath(args[1]);repo=os.path.realpath(os.path.dirname(os.path.dirname(script)))
root=os.environ.get("OSX_PROJECTS_ROOT","")
source="environment"
if not root:
    p=subprocess.run(["/bin/launchctl","getenv","OSX_PROJECTS_ROOT"],capture_output=True,text=True,timeout=3)
    root=p.stdout.strip() if p.returncode==0 else ""
    source="launchctl"
if not root:
    root=os.path.dirname(repo)
    source="launchd-repository-parent"
root=os.path.realpath(root)
node=os.path.realpath(args[2])
if not (os.path.isdir(repo) and os.path.isdir(root) and os.path.isfile(node) and os.path.commonpath([repo,root])==root): raise ValueError("INVALID_MAC_PROJECT_ROOT")
print(json.dumps({"platform":platform.system(),"principal":pwd.getpwuid(os.getuid()).pw_name,"uid":os.getuid(),"projectsRoot":root,"projectRootSource":source,"repoRoot":repo,"node":node,"launchAgent":label},separators=(",",":")))
`;

export function validateMacDiscovery(value, { expectedPrincipal, expectedRoot } = {}) {
  if (!value || typeof value !== 'object' || value.platform !== 'Darwin' ||
      typeof value.principal !== 'string' || !value.principal ||
      !Number.isInteger(value.uid) || value.uid < 1 ||
      value.launchAgent !== 'io.revrebel.agent-bridge' ||
      typeof value.projectsRoot !== 'string' ||
      !path.posix.isAbsolute(value.projectsRoot) || value.projectsRoot === '/' ||
      path.posix.normalize(value.projectsRoot) !== value.projectsRoot ||
      typeof value.repoRoot !== 'string' ||
      !path.posix.isAbsolute(value.repoRoot) ||
      path.posix.normalize(value.repoRoot) !== value.repoRoot ||
      !(value.repoRoot === value.projectsRoot ||
        value.repoRoot.startsWith(value.projectsRoot + '/')) ||
      !['environment', 'launchctl', 'launchd-repository-parent'].includes(value.projectRootSource) ||
      typeof value.node !== 'string' || !path.posix.isAbsolute(value.node))
    throw Error('MAC_CONFIG_UNVERIFIED');
  if ((expectedPrincipal && value.principal !== expectedPrincipal) ||
      (expectedRoot && value.projectsRoot !== expectedRoot))
    throw Error('MAC_IDENTITY_MISMATCH');
  return Object.freeze({ ...value });
}

export async function probeMacOverTrustedSsh({
  sshAlias, expectedPrincipal, expectedRoot,
  sshConfigPath = null, timeoutMs = 10_000, launch = spawn,
}) {
  if (!ALIAS.test(sshAlias ?? '') || sshAlias.startsWith('-') ||
      (sshConfigPath !== null && (!path.posix.isAbsolute(sshConfigPath) ||
        sshConfigPath.includes('\n') || sshConfigPath.includes('\0'))) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 15_000)
    throw Error('UNAPPROVED_SSH_TARGET');
  const encoded = Buffer.from(PYTHON, 'utf8').toString('base64');
  const command = `/usr/bin/python3 -c "import base64;exec(base64.b64decode('${encoded}'))"`;
  const args = [
    ...(sshConfigPath ? ['-F', sshConfigPath] : []),
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no',
    '-o', 'ClearAllForwardings=yes', '-o', 'ControlMaster=no',
    '-o', 'ConnectionAttempts=1', '-o', 'ConnectTimeout=5',
    '-T', sshAlias, command,
  ];
  const child = launch('/usr/bin/ssh', args, {
    env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', LANG: 'C.UTF-8' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout = (stdout + bytes.toString('utf8')).slice(-12_288); });
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString('utf8')).slice(-12_288); });
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Error('MAC_SSH_PROBE_TIMEOUT'));
    }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve(code); });
  });
  if (exit !== 0) {
    if (/Host key verification failed|No .* host key is known|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr))
      throw Error('MAC_SSH_HOST_KEY_NOT_TRUSTED');
    throw Error('MAC_SSH_OFFLINE_OR_REJECTED');
  }
  let parsed;
  try { parsed = JSON.parse(stdout.trim()); }
  catch { throw Error('MAC_CONFIG_UNVERIFIED'); }
  return validateMacDiscovery(parsed, { expectedPrincipal, expectedRoot });
}
