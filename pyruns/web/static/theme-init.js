try {
  const savedTheme = localStorage.getItem('pyruns_theme')
  document.documentElement.className = savedTheme === 'dark' ? 'dark' : 'light'
} catch (_) {
  // Default to light when browser storage is unavailable.
}
