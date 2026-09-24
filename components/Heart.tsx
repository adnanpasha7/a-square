export function Heart({ className = "" }: { className?: string }) {
  return (
    <svg className={`heart ${className}`} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 21s-7.4-4.5-9.9-9.2C.5 8.4 2.4 4.5 6.1 4.1 8.4 3.9 10.5 5 12 7c1.5-2 3.6-3.1 5.9-2.9 3.7.4 5.6 4.3 4 7.7C19.4 16.5 12 21 12 21z" />
    </svg>
  );
}

// Two identical layers stacked on top of each other: the left half is shown solid,
// the right half outlined. The split runs straight through the heart.
export function Wordmark() {
  const letters = (
    <>
      <span>A</span>
      <Heart className="beat" />
      <span>A</span>
    </>
  );
  return (
    <h1 className="wordmark" aria-label="A heart A">
      <span className="wm wm-solid" aria-hidden="true">{letters}</span>
      <span className="wm wm-outline" aria-hidden="true">{letters}</span>
    </h1>
  );
}
