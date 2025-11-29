# Authentication System Implementation Plan

## Overview
Implement a full authentication system with:
- Public/anonymous access with 10 search limit (like aum13f.com)
- Email/password signup and login
- Persistent sessions
- User profile display in sidebar

## Technology Choice: Supabase Auth
Using Supabase Auth because:
- Already have @supabase/supabase-js installed
- Native integration with existing Supabase data
- Handles security best practices (password hashing, JWT tokens)
- Free tier is generous (50k monthly active users)
- No additional dependencies needed

## Architecture

### 1. Database Setup (Supabase Dashboard)
- Supabase Auth already has `auth.users` table built-in
- Create `profiles` table (optional, for extended user data)
- Enable Email/Password auth in Supabase Dashboard

### 2. Frontend Components (app.js)

#### Auth State Management
```javascript
// Add to App() state
const [user, setUser] = useState(null);
const [authLoading, setAuthLoading] = useState(true);
const [searchCount, setSearchCount] = useState(0);
const [showAuthModal, setShowAuthModal] = useState(false);
const [authMode, setAuthMode] = useState('login'); // 'login' | 'signup'
```

#### New Components
1. **AuthModal** - Login/Signup modal with:
   - Email input
   - Password input
   - Toggle between login/signup
   - Error display
   - Loading states

2. **UserProfileSection** - Sidebar footer showing:
   - When logged in: Avatar + email + logout button
   - When anonymous: "Sign In" button + searches remaining

3. **SearchLimitBanner** - Shows when approaching/at limit:
   - "X searches remaining" counter
   - "Sign up for unlimited access" CTA

### 3. Rate Limiting Implementation

#### Anonymous Users (localStorage-based)
```javascript
const SEARCH_LIMIT = 10;
const STORAGE_KEY = 'pmip_search_count';
const STORAGE_DATE_KEY = 'pmip_search_date';

// Reset daily to prevent permanent lockout
const getSearchCount = () => {
  const today = new Date().toDateString();
  const storedDate = localStorage.getItem(STORAGE_DATE_KEY);
  if (storedDate !== today) {
    localStorage.setItem(STORAGE_DATE_KEY, today);
    localStorage.setItem(STORAGE_KEY, '0');
    return 0;
  }
  return parseInt(localStorage.getItem(STORAGE_KEY) || '0');
};

const incrementSearchCount = () => {
  const count = getSearchCount() + 1;
  localStorage.setItem(STORAGE_KEY, count.toString());
  return count;
};
```

#### Integration Points
- Wrap search functions to check limit before executing
- Show modal when limit reached
- Logged-in users bypass limit entirely

### 4. Auth Flow

#### Signup Flow
1. User clicks "Sign Up" in sidebar
2. Modal opens with signup form
3. User enters email + password
4. Supabase creates account + sends confirmation email
5. User confirms email
6. Auto-login after confirmation

#### Login Flow
1. User clicks "Sign In"
2. Modal opens with login form
3. User enters credentials
4. Supabase verifies + returns session
5. Session stored in localStorage
6. UI updates to show logged-in state

#### Session Persistence
- Supabase handles JWT refresh automatically
- Check session on app load
- Listen for auth state changes

### 5. UI/UX Design (Gemini-style)

#### Auth Modal Design
- Clean, minimal design matching app aesthetic
- Source Serif 4 for headings
- Inter for body text
- Slate color palette
- Subtle shadow, 8px border radius
- Centered overlay with backdrop blur

#### Sidebar User Section
Located at bottom of sidebar:
```
+---------------------------+
| [Avatar] user@email.com   |
| [Settings] [Logout]       |
+---------------------------+
```
or for anonymous:
```
+---------------------------+
| 7/10 searches remaining   |
| [Sign In for Unlimited]   |
+---------------------------+
```

## Implementation Steps

### Phase 1: Supabase Auth Setup
1. Enable Email Auth in Supabase Dashboard
2. Add Supabase Auth client initialization to app.js
3. Add auth state hooks

### Phase 2: Auth Modal Component
4. Create AuthModal component
5. Implement login form
6. Implement signup form
7. Add form validation and error handling

### Phase 3: Session Management
8. Add session persistence check on load
9. Listen for auth state changes
10. Add logout functionality

### Phase 4: Rate Limiting
11. Add localStorage search tracking
12. Integrate limit check into search functions
13. Add "searches remaining" display

### Phase 5: UI Integration
14. Add UserProfileSection to Sidebar
15. Add SearchLimitBanner to main content area
16. Polish transitions and loading states

## Files to Modify
1. `public/index.html` - Add Supabase Auth JS (CDN)
2. `public/app.js` - Add auth components and state
3. `server.js` - (Optional) Add server-side session validation for protected API routes

## Security Considerations
- Passwords never stored in plaintext (Supabase handles)
- JWT tokens auto-refresh
- Email confirmation required for signup
- Rate limit stored client-side (easily bypassable, but sufficient for casual deterrence)
- For stronger protection: implement server-side rate limiting with IP tracking

## Estimated Scope
- ~400 lines of new React code
- ~30 minutes of Supabase Dashboard configuration
- No new dependencies required

## Future Enhancements (Not in Scope)
- OAuth providers (Google, GitHub)
- Password reset flow
- User profile settings page
- Server-side rate limiting with Redis
- Subscription tiers with payment (Stripe)
