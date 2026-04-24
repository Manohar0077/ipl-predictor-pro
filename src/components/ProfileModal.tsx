import { useState, useRef } from "react";
import { User } from "@/lib/api";
import { X, Upload, Trash2, User as UserIcon, Lock, Image as ImageIcon } from "lucide-react";
import { getAvatarUrl } from "@/lib/utils";
import Cropper from 'react-easy-crop';
import { getCroppedImg } from "@/lib/imageUtils";

const PRESETS = [
  "https://api.dicebear.com/9.x/notionists/svg?seed=Felix&backgroundColor=f5f5f5",
  "https://api.dicebear.com/9.x/notionists/svg?seed=Aneka&backgroundColor=f5f5f5",
  "https://api.dicebear.com/9.x/notionists/svg?seed=Leo&backgroundColor=f5f5f5",
  "https://api.dicebear.com/9.x/notionists/svg?seed=Mia&backgroundColor=f5f5f5",
  "https://api.dicebear.com/9.x/notionists/svg?seed=Jack&backgroundColor=f5f5f5",
  "https://api.dicebear.com/9.x/notionists/svg?seed=Zoe&backgroundColor=f5f5f5",
  "https://api.dicebear.com/9.x/notionists/svg?seed=Lily&backgroundColor=f5f5f5",
  "https://api.dicebear.com/9.x/notionists/svg?seed=Sam&backgroundColor=f5f5f5",
  "https://api.dicebear.com/9.x/notionists/svg?seed=Max&backgroundColor=f5f5f5",
  "https://api.dicebear.com/9.x/notionists/svg?seed=Luna&backgroundColor=f5f5f5",
  "https://api.dicebear.com/9.x/notionists/svg?seed=Oliver&backgroundColor=f5f5f5",
  "https://api.dicebear.com/9.x/notionists/svg?seed=Chloe&backgroundColor=f5f5f5",
  "https://api.dicebear.com/9.x/notionists/svg?seed=Finn&backgroundColor=f5f5f5",
  "https://api.dicebear.com/9.x/notionists/svg?seed=Ruby&backgroundColor=f5f5f5",
  "https://api.dicebear.com/9.x/notionists/svg?seed=Milo&backgroundColor=f5f5f5",
  "https://api.dicebear.com/9.x/notionists/svg?seed=Nina&backgroundColor=f5f5f5",
];

interface Props {
  user: User;
  onClose: () => void;
  onLogout: () => void;
  onSave: (data: { profile_pic?: string | null; username?: string; password?: string }) => Promise<void>;
}

export default function ProfileModal({ user, onClose, onLogout, onSave }: Props) {
  const [tab, setTab] = useState<"account" | "avatar">("avatar");

  // State
  const [selectedPic, setSelectedPic] = useState<string | null>(user.profile_pic || null);
  const [username, setUsername] = useState(user.username);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const [loading, setLoading] = useState(false);

  // Cropping State
  const [imageToCrop, setImageToCrop] = useState<string | null>(null);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<any>(null);

  const handleSave = async () => {
    setError("");
    const payload: { profile_pic?: string | null; username?: string; password?: string } = {};

    if (username.trim() !== user.username) {
      if (username.trim().length < 2) {
        setError("Username must be at least 2 characters");
        setTab("account");
        return;
      }
      payload.username = username.trim();
    }
    if (password) {
      if (password.length < 6) {
        setError("Password must be at least 6 characters");
        setTab("account");
        return;
      }
      payload.password = password;
    }
    
    // Always send profile pic if it changed, or even if didn't to be safe, 
    // but the backend handles undefined gracefully so let's only send if it changed.
    // Wait, since we are doing a unified form, let's just send the current selectedPic.
    if (selectedPic !== (user.profile_pic || null)) {
      payload.profile_pic = selectedPic;
    }

    if (Object.keys(payload).length === 0) {
      onClose(); // No changes
      return;
    }

    setLoading(true);
    try {
      await onSave(payload);
    } catch (err: any) {
      setError(err.message || "Failed to save profile");
    } finally {
      setLoading(false);
    }
  };

  const handleApplyCrop = async () => {
    if (imageToCrop && croppedAreaPixels) {
      try {
        const croppedImage = await getCroppedImg(imageToCrop, croppedAreaPixels);
        if (croppedImage) {
          setSelectedPic(croppedImage);
        }
      } catch (e) {
        console.error("Failed to crop image", e);
      }
      setImageToCrop(null);
    }
  };

  const processFile = (file: File) => {
    if (!file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      setImageToCrop(e.target?.result as string);
      setZoom(1);
      setCrop({ x: 0, y: 0 });
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-background/80 backdrop-blur-sm">
      <div className="flex min-h-full items-center justify-center p-4">
        <div className="relative w-full max-w-md animate-scale-in rounded-2xl border border-border bg-gradient-card shadow-2xl p-6">
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-display text-2xl text-gradient-gold">EDIT PROFILE</h3>
          <button onClick={onClose} className="rounded-lg p-1 text-muted-foreground hover:bg-muted transition-colors">
            <X size={18} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-border/50 mb-6 mt-4">
          <button
            onClick={() => setTab("avatar")}
            className={`flex-1 flex items-center justify-center gap-2 pb-3 text-sm font-semibold transition-colors border-b-2 ${
              tab === "avatar" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <ImageIcon size={16} /> AVATAR
          </button>
          <button
            onClick={() => setTab("account")}
            className={`flex-1 flex items-center justify-center gap-2 pb-3 text-sm font-semibold transition-colors border-b-2 ${
              tab === "account" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <UserIcon size={16} /> ACCOUNT
          </button>
        </div>

        {/* Form Body */}
        {tab === "avatar" ? (
          <div className="animate-fade-in">
            {/* Current Avatar preview */}
            <div className="flex flex-col items-center justify-center mb-6">
              <div className="relative h-24 w-24 mb-3 border border-border shadow-sm rounded-full overflow-hidden flex items-center justify-center bg-muted text-foreground font-display text-3xl shrink-0">
                <img src={selectedPic || getAvatarUrl(user.profile_pic, user.username)} alt="Selected" className="h-full w-full object-cover" />
              </div>
              <div className="flex gap-2">
                <label className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-muted/50 px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-muted transition-colors shrink-0">
                  <Upload size={12} /> UPLOAD PHOTO
                  <input
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    onChange={(e) => {
                      if (e.target.files?.[0]) {
                        processFile(e.target.files[0]);
                        e.target.value = "";
                      }
                    }}
                  />
                </label>
                {(selectedPic !== null) && (
                  <button
                    type="button"
                    onClick={() => setSelectedPic(null)}
                    className="flex items-center gap-1.5 rounded-lg border border-transparent px-3 py-1.5 text-xs font-semibold text-destructive hover:bg-destructive/10 transition-colors shrink-0"
                  >
                    <Trash2 size={12} /> REMOVE
                  </button>
                )}
              </div>
            </div>

            {/* Presets Grid */}
            <div className="mb-6">
              <p className="text-xs uppercase tracking-widest text-muted-foreground mb-3 text-center">Or Pick an Avatar</p>
              <div className="grid grid-cols-4 sm:grid-cols-4 gap-3 max-h-48 overflow-y-auto px-1 pb-1 custom-scrollbar">
                {PRESETS.map((url, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setSelectedPic(url)}
                    className={`group relative aspect-square overflow-hidden rounded-xl border border-border transition-all hover:scale-105 ${
                      selectedPic === url ? "ring-2 ring-primary ring-offset-2 ring-offset-background" : "hover:border-primary/50"
                    }`}
                  >
                    <img src={url} alt={`Avatar ${i + 1}`} className="h-full w-full object-cover" />
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="animate-fade-in space-y-4 mb-6">
            <div>
              <label className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-foreground">
                <UserIcon size={14} className="text-muted-foreground" /> Username
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="2-20 characters"
                className="w-full rounded-xl border border-border bg-muted px-4 py-2.5 text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                minLength={2}
                maxLength={20}
              />
            </div>
            <div>
              <label className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-foreground">
                <Lock size={14} className="text-muted-foreground" /> New Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Leave blank to keep current"
                className="w-full rounded-xl border border-border bg-muted px-4 py-2.5 text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
              <p className="mt-1.5 text-[10px] text-muted-foreground">Requires at least 6 characters if changing</p>
            </div>
          </div>
        )}

        {error && <p className="mb-4 text-center text-sm font-semibold text-destructive animate-fade-in">{error}</p>}

        {/* Footer Actions */}
        <div className="flex flex-col gap-3">
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 rounded-xl border border-border py-3 text-sm font-semibold text-muted-foreground hover:bg-muted transition-colors"
            >
              CANCEL
            </button>
            <button
              onClick={handleSave}
              disabled={loading}
              className="flex-1 rounded-xl bg-primary py-3 font-display text-lg tracking-wider text-primary-foreground hover:brightness-110 disabled:opacity-50 transition-all glow-gold"
            >
              {loading ? "SAVING..." : "SAVE CHANGES"}
            </button>
          </div>
          
          <button
            onClick={onLogout}
            className="w-full flex items-center justify-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 py-3 text-sm font-bold text-destructive hover:bg-destructive hover:text-white transition-all uppercase tracking-widest mt-2"
          >
            <Lock size={16} /> LOGOUT
          </button>
        </div>

        {/* Cropping UI Overlay */}
        {imageToCrop && (
          <div className="absolute inset-0 z-[60] flex flex-col bg-background p-6 rounded-2xl animate-scale-in">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display text-xl text-gradient-gold">ADJUST PHOTO</h3>
              <button onClick={() => setImageToCrop(null)} className="rounded-lg p-1 text-muted-foreground hover:bg-muted transition-colors">
                <X size={18} />
              </button>
            </div>
            
            <div className="relative flex-1 w-full min-h-[250px] rounded-xl overflow-hidden bg-black border border-border">
              <Cropper
                image={imageToCrop}
                crop={crop}
                zoom={zoom}
                aspect={1}
                cropShape="round"
                showGrid={false}
                onCropChange={setCrop}
                onCropComplete={(_, pixels) => setCroppedAreaPixels(pixels)}
                onZoomChange={setZoom}
              />
            </div>
            
            <div className="mt-6 space-y-6">
              <div className="space-y-2">
                <div className="flex justify-between text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  <span>Zoom</span>
                  <span>{Math.round(zoom * 100)}%</span>
                </div>
                <input
                  type="range"
                  value={zoom}
                  min={1}
                  max={3}
                  step={0.1}
                  onChange={(e) => setZoom(Number(e.target.value))}
                  className="w-full h-1.5 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
                />
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => setImageToCrop(null)}
                  className="flex-1 rounded-xl border border-border py-3 text-sm font-semibold text-muted-foreground hover:bg-muted transition-colors"
                >
                  CANCEL
                </button>
                <button
                  onClick={handleApplyCrop}
                  className="flex-1 rounded-xl bg-primary py-3 font-display text-lg tracking-wider text-primary-foreground hover:brightness-110 transition-all glow-gold shadow-[0_0_15px_rgba(251,191,36,0.3)]"
                >
                  APPLY CROP
                </button>
              </div>
            </div>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
