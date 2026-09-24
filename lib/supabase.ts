import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  { auth: { persistSession: true, autoRefreshToken: true } },
);

export type Message = {
  id: string;
  sender_id: string;
  body: string | null;
  image_path: string | null;
  thumb_path: string | null;
  image_width: number | null;
  image_height: number | null;
  created_at: string;
  read_at: string | null;
  edited_at: string | null;
  deleted_at: string | null; // unsent: body and image fields are null
};

export type Reaction = {
  message_id: string;
  user_id: string;
  emoji: string;
  created_at: string;
};

export type Member = { user_id: string; display_name: string };

export const BUCKET = "photos";
