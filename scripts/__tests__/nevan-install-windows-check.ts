import { strict as assert } from 'node:assert'
import { readFileSync } from 'fs'

const startServices = readFileSync('scripts/start-services.ts', 'utf8')
const windowsInstaller = readFileSync('scripts/install-nevan.ps1', 'utf8')
const unixInstaller = readFileSync('scripts/install-nevan.sh', 'utf8')

assert(startServices.includes('function resolveBunPath'), 'start-services should resolve Bun path cross-platform')
assert(startServices.includes('process.execPath'), 'start-services should reuse the current Bun executable')
assert(!startServices.includes("const BUN_PATH = join(PROJECT_ROOT, '.bin', 'bun')"), 'start-services must not hard-code the bash .bin/bun wrapper')

assert(windowsInstaller.includes('function Ensure-NevanDependencies'), 'Windows launcher should repair missing dependencies')
assert(windowsInstaller.includes('react\\jsx-dev-runtime.js'), 'Windows launcher should check for React JSX runtime')
assert(windowsInstaller.includes('& `$BunPath install --cwd `$RepoDir --force'), 'Windows launcher should force reinstall when dependencies are missing')
assert(windowsInstaller.includes('if (`$LASTEXITCODE -ne 0) { exit `$LASTEXITCODE }'), 'Windows launcher should stop on service startup failure')

assert(unixInstaller.includes('ensure_nevan_dependencies()'), 'Unix launcher should repair missing dependencies')
assert(unixInstaller.includes('node_modules/react/jsx-dev-runtime.js'), 'Unix launcher should check for React JSX runtime')
assert(unixInstaller.includes('"\\$BUN_BIN" install --cwd "\\$REPO_DIR" --force'), 'Unix launcher should force reinstall when dependencies are missing')
assert(unixInstaller.includes('start_services || exit $?'), 'Unix launcher should stop on service startup failure')

console.log('nevan installer Windows hardening checks passed')
