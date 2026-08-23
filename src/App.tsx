export default function App() {
  return (
    <main
      style={{
        display: 'grid',
        placeItems: 'center',
        height: '100%',
        gap: 'var(--space-2)',
      }}
    >
      <h1 style={{ font: `500 var(--text-display)/1.1 var(--font-display)`, margin: 0 }}>
        Print Machine
      </h1>
      <p style={{ color: 'var(--ink-3)', fontSize: 'var(--text-sm)', margin: 0 }}>
        Scaffold. The press is not built yet.
      </p>
    </main>
  )
}
