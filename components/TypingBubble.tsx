export default function TypingBubble({ name }: { name: string }) {
  return (
    <div className="msg theirs typing-msg" role="status" aria-label={`${name} is typing`}>
      <div className="bubble typing-bubble" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}
