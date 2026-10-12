import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'

const root=fileURLToPath(new URL('..',import.meta.url))
const source=join(root,'vendor','open-computer-use-windows')
const env={...process.env,GOTOOLCHAIN:'local',GOWORK:'off',GOPROXY:'off',CGO_ENABLED:'0'}
const run=(args,extra={})=>{
  const result=spawnSync('go',args,{cwd:source,env:{...env,...extra},windowsHide:true,stdio:'inherit'})
  if(result.error) throw new Error(`Building the bundled Windows driver needs Go 1.22 or later: ${result.error.message}`)
  if(result.status!==0) process.exit(result.status ?? 1)
}
if(process.argv.includes('--test')) { run(['test','-count=1','./...']); process.exit(0) }
const hash=createHash('sha256')
for(const name of readdirSync(source).filter(name=>(name.endsWith('.go') || name.endsWith('.cs')) || name==='runtime.ps1' || name==='go.mod').sort()) hash.update(name).update(readFileSync(join(source,name)))
hash.update(readFileSync(fileURLToPath(import.meta.url)))
const digest=hash.digest('hex')
for(const [nodeArch,goArch] of [['x64','amd64'],['arm64','arm64']]) {
  const directory=join(root,'dist','native',`win32-${nodeArch}`)
  const output=join(directory,'open-computer-use.exe'), stamp=join(directory,'source.sha256')
  if(existsSync(output) && existsSync(stamp) && readFileSync(stamp,'utf8')===digest) continue
  mkdirSync(directory,{recursive:true})
  run(['build','-trimpath','-ldflags=-s -w -buildid=','-o',output,'.'],{GOOS:'windows',GOARCH:goArch})
  writeFileSync(stamp,digest)
  console.log(`Built bundled Windows driver (${nodeArch})`)
}
