export const SpinnerDots = () => (
  <span style={{ display: 'inline-flex', gap: 2, alignItems: 'center' }}>
    {[0, 160, 320].map(delay => (
      <span
        key={delay}
        style={{
          width: 3,
          height: 3,
          borderRadius: '50%',
          background: 'rgba(255,255,255,0.5)',
          animation: 'cvd-blink 0.96s infinite ease-in-out',
          animationDelay: `${delay}ms`,
          display: 'block',
        }}
      />
    ))}
    <style>{`@keyframes cvd-blink{0%,80%,100%{opacity:.2}40%{opacity:1}}`}</style>
  </span>
);
