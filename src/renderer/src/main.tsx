import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './assets/main.css'

// Default to dark theme; restore saved preference if present.
const saved = localStorage.getItem('theme')
if (saved === 'light') document.documentElement.classList.remove('dark')
else document.documentElement.classList.add('dark')

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
