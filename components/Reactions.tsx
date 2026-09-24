import type { Reaction } from "@/lib/supabase";

// Small glass chip overlapping the bubble's bottom corner: "❤️", "❤️ 😂", or "❤️ 2" when you match
export function ReactionChip({
  reactions,
  userId,
  partnerName,
}: {
  reactions: Reaction[];
  userId: string;
  partnerName: string;
}) {
  if (!reactions.length) return null;
  const ordered = [...reactions].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const mine = ordered.find((r) => r.user_id === userId);
  const theirs = ordered.find((r) => r.user_id !== userId);
  const same = !!mine && !!theirs && mine.emoji === theirs.emoji;
  const emojis = same ? [mine.emoji] : ordered.map((r) => r.emoji);
  const label = [mine && `You reacted ${mine.emoji}`, theirs && `${partnerName} reacted ${theirs.emoji}`]
    .filter(Boolean)
    .join(", ");

  return (
    <span className="reactions" role="img" aria-label={label} key={emojis.join("")}>
      {emojis.map((e, i) => (
        <span key={i}>{e}</span>
      ))}
      {same && <span className="reactions-count">2</span>}
    </span>
  );
}
