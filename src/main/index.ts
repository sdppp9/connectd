import { app, shell, BrowserWindow, nativeImage } from 'electron'
import { join } from 'path'
import { registerIpc } from './ipc'
import { manager } from './db/manager'
import { migrateLegacyData } from './store/migrate'
import { SPLASH_HTML } from './splash'

// Fix the app name so dev and packaged builds share ONE userData folder,
// regardless of package.json "name". Must run before userData is read.
app.setName('ConnectD')

const isDev = !app.isPackaged

let splashWindow: BrowserWindow | null = null

function createSplash(): void {
  splashWindow = new BrowserWindow({
    width: 340,
    height: 210,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    center: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: true,
    backgroundColor: '#00000000'
  })
  splashWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(SPLASH_HTML))
  splashWindow.on('closed', () => (splashWindow = null))
}

function closeSplash(): void {
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close()
  splashWindow = null
}

function createWindow(): void {
  const iconPath = join(__dirname, '../../build/icon.png')
  const icon = nativeImage.createFromPath(iconPath)

  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'ConnectD',
    backgroundColor: '#0b0f1a',
    icon: icon.isEmpty() ? undefined : icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    closeSplash()
    mainWindow.show()
    mainWindow.focus()
  })

  // Safety net: never leave the splash stuck if load stalls.
  setTimeout(closeSplash, 15000)

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  createSplash()
  migrateLegacyData()
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', async () => {
  await manager.closeAll()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  await manager.closeAll()
})
