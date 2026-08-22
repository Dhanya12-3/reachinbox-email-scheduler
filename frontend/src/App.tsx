import { useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  Filter,
  Mail,
  Plus,
  RefreshCw,
  Search,
  Send,
  X,
} from 'lucide-react';

type User = {
  id: string;
  name?: string;
  email: string;
  avatar?: string | null;
};

type Email = {
  id: string;
  recipientEmail: string;
  subject: string;
  body: string;
  scheduledAt: string;
  sentAt?: string | null;
  status: string;
};

const configuredApi = import.meta.env.VITE_API_URL?.trim();
const API = (configuredApi || (import.meta.env.DEV ? 'http://localhost:4000' : window.location.origin)).replace(/\/$/, '');

const scheduledStatuses = ['SCHEDULED'];

const formatTime = (value?: string | null) =>
  value
    ? new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }).format(new Date(value))
    : '—';

const preview = (body: string) =>
  body.length > 110 ? `${body.slice(0, 110)}...` : body;

async function api(path: string, options: RequestInit = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error ?? 'Request failed');
  }

  return data;
}

const buttonBase =
  'inline-flex items-center justify-center gap-2 rounded-lg text-sm font-semibold transition focus:outline-none focus:ring-2 focus:ring-emerald-200 disabled:cursor-not-allowed disabled:opacity-50';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [emails, setEmails] = useState<Email[]>([]);
  const [view, setView] = useState<'queued' | 'scheduled' | 'sent'>('queued');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [composeOpen, setComposeOpen] = useState(false);

  const load = async () => {
    try {
      const me = await api('/auth/me');

      if (!me.authenticated) {
        setUser(null);
        return;
      }

      const emailData = await api('/api/emails');

      setUser(me.user);
      setEmails(emailData.emails);
      const sentEmails = emailData.emails.filter((email: Email) => email.status === 'SENT');
      console.log(`[DEBUG] FRONTEND SENT DATA ids=${sentEmails.map((email: Email) => email.id).join(',') || 'none'}`);
      setError('');
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Unable to load your emails.'
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();

    const timer = window.setInterval(() => {
      void load();
    }, 10000);

    return () => window.clearInterval(timer);
  }, []);

  const visible = useMemo(
    () =>
      emails.filter((email) => {
        const matchesView =
          view === 'sent'
            ? email.status === 'SENT'
            : view === 'queued'
              ? ['QUEUED', 'PROCESSING'].includes(email.status)
              : scheduledStatuses.includes(email.status);

        const query = search.toLowerCase();

        return (
          matchesView &&
          (!query ||
            email.recipientEmail.toLowerCase().includes(query) ||
            email.subject.toLowerCase().includes(query))
        );
      }),
    [emails, search, view]
  );

  if (!user) {
    return <Login />;
  }

  const logout = async () => {
    await api('/auth/logout', {
      method: 'POST',
    });

    setUser(null);
  };

  const queuedCount = emails.filter((email) =>
    ['QUEUED', 'PROCESSING'].includes(email.status)
  ).length;

  const scheduledCount = emails.filter((email) =>
    scheduledStatuses.includes(email.status)
  ).length;

  const sentCount = emails.filter((email) =>
    email.status === 'SENT'
  ).length;

  return (
    <div className="min-h-screen bg-white text-slate-800 lg:flex">
      <Sidebar
        user={user}
        active={view}
        onChange={setView}
        onCompose={() => setComposeOpen(true)}
        onLogout={() => void logout()}
        queuedCount={queuedCount}
        scheduledCount={scheduledCount}
        sentCount={sentCount}
      />

      <div className="min-w-0 flex-1 bg-slate-50/60">
        <header className="flex h-16 items-center justify-between border-b border-slate-200 bg-white px-5 sm:px-8">
          <div className="flex items-center gap-3">
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                size={16}
              />

              <input
                aria-label="Search emails"
                className="h-9 w-48 rounded-md border border-slate-200 bg-slate-50 pl-9 pr-3 text-xs outline-none focus:border-emerald-400 focus:bg-white sm:w-64"
                placeholder="Search emails"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>

            <button
              className="grid h-9 w-9 place-items-center rounded-md border border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
              title="Filter"
            >
              <Filter size={15} />
            </button>
          </div>

          <button
            className="grid h-9 w-9 place-items-center rounded-md border border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
            title="Refresh"
            onClick={() => void load()}
          >
            <RefreshCw size={15} />
          </button>
        </header>

        <main className="mx-auto max-w-5xl px-5 py-8 sm:px-8 lg:px-10">
          <div className="mb-8">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-600">
              Email workspace
            </p>

            <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
              {view === 'queued'
                ? 'Queued emails'
                : view === 'scheduled'
                  ? 'Scheduled emails'
                  : 'Sent emails'}
            </h1>

            <p className="mt-2 text-sm text-slate-500">
              {view === 'sent'
                ? 'Review messages delivered through your workspace.'
                : view === 'queued'
                  ? 'Messages waiting to be sent.'
                  : 'Keep track of upcoming scheduled messages.'}
            </p>
          </div>

          {error && (
            <div className="mb-5 rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <EmailList
            rows={visible}
            view={view}
            loading={loading}
          />
        </main>
      </div>

      {composeOpen && (
        <Compose
          onClose={() => setComposeOpen(false)}
          onDone={() => {
            setComposeOpen(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

function Sidebar({
  user,
  active,
  onChange,
  onCompose,
  onLogout,
  queuedCount,
  scheduledCount,
  sentCount,
}: {
  user: User;
  active: 'queued' | 'scheduled' | 'sent';
  onChange: (view: 'queued' | 'scheduled' | 'sent') => void;
  onCompose: () => void;
  onLogout: () => void;
  queuedCount: number;
  scheduledCount: number;
  sentCount: number;
}) {
  const [profileOpen, setProfileOpen] = useState(false);

  const initials = (user.name ?? user.email)
    .slice(0, 1)
    .toUpperCase();

  return (
    <aside className="flex w-full shrink-0 flex-col border-b border-slate-200 bg-white lg:min-h-screen lg:w-64 lg:border-b-0 lg:border-r">
      <div className="flex h-16 items-center border-b border-slate-100 px-5">
        <div className="flex items-center gap-2.5 text-lg font-extrabold tracking-tight text-slate-900">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-emerald-700 font-serif text-lg text-emerald-100">
            R
          </span>

          reach
          <span className="text-emerald-600">inbox</span>
        </div>
      </div>

      <div className="relative border-b border-slate-100 p-4">
        <button
          className="flex w-full items-center gap-3 rounded-lg p-2 text-left hover:bg-slate-50"
          onClick={() => setProfileOpen((open) => !open)}
        >
          <span className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-full bg-emerald-100 text-sm font-bold text-emerald-800">
            {user.avatar ? (
              <img
                src={user.avatar}
                alt=""
                className="h-full w-full object-cover"
              />
            ) : (
              initials
            )}
          </span>

          <span className="min-w-0 flex-1">
            <strong className="block truncate text-xs font-semibold text-slate-800">
              {user.name ?? user.email.split('@')[0]}
            </strong>

            <small className="block truncate text-[11px] text-slate-500">
              {user.email}
            </small>
          </span>

          <ChevronDown
            size={15}
            className={`text-slate-400 transition ${
              profileOpen ? 'rotate-180' : ''
            }`}
          />
        </button>

        {profileOpen && (
          <div className="absolute left-4 right-4 top-[74px] z-20 rounded-lg border border-slate-200 bg-white p-2 shadow-lg">
            <div className="border-b border-slate-100 px-3 py-2">
              <p className="truncate text-xs font-semibold text-slate-800">
                {user.name ?? user.email}
              </p>

              <p className="truncate text-[11px] text-slate-500">
                {user.email}
              </p>
            </div>

            <button
              className="mt-1 w-full rounded-md px-3 py-2 text-left text-xs font-semibold text-slate-600 hover:bg-red-50 hover:text-red-700"
              onClick={onLogout}
            >
              Log out
            </button>
          </div>
        )}
      </div>

      <nav className="flex gap-1 p-4 lg:block lg:space-y-1">
        {/* ONLY COMPOSE BUTTON */}
        <button
          className={`${buttonBase} w-full justify-start bg-emerald-700 px-3 py-2.5 text-white hover:bg-emerald-800`}
          onClick={onCompose}
        >
          <Plus size={16} />
          Compose
        </button>

        <NavItem
          active={active === 'queued'}
          onClick={() => onChange('queued')}
          label="Queued"
          count={queuedCount}
        />

        <NavItem
          active={active === 'scheduled'}
          onClick={() => onChange('scheduled')}
          label="Scheduled"
          count={scheduledCount}
        />

        <NavItem
          active={active === 'sent'}
          onClick={() => onChange('sent')}
          label="Sent"
          count={sentCount}
        />
      </nav>
    </aside>
  );
}

function NavItem({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      className={`flex min-h-10 w-full items-center justify-between rounded-lg px-3 text-xs font-semibold transition ${
        active
          ? 'bg-emerald-50 text-emerald-800'
          : 'text-slate-500 hover:bg-slate-50 hover:text-slate-800'
      }`}
      onClick={onClick}
    >
      <span className="flex items-center gap-2">
        <Mail size={15} />
        {label}
      </span>

      <span
        className={`rounded-full px-2 py-0.5 text-[10px] ${
          active
            ? 'bg-white text-emerald-700'
            : 'bg-slate-100 text-slate-500'
        }`}
      >
        {count}
      </span>
    </button>
  );
}

function Login() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const signIn = async () => {
    setBusy(true);
    setMessage('');

    try {
      await api('/auth/email', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });

      window.location.reload();
    } catch (reason) {
      setMessage(
        reason instanceof Error
          ? reason.message
          : 'Unable to sign in.'
      );

      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-5 py-10">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-sm sm:p-10">
        <div className="mb-12 flex items-center gap-2.5 text-xl font-extrabold tracking-tight text-slate-900">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-emerald-700 font-serif text-xl text-emerald-100">
            R
          </span>

          reach
          <span className="text-emerald-600">inbox</span>
        </div>

        <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-600">
          Welcome back
        </p>

        <h1 className="text-3xl font-bold tracking-tight text-slate-900">
          Sign in to your workspace
        </h1>

        <p className="mt-3 text-sm leading-6 text-slate-500">
          Enter your email to continue managing scheduled and sent emails.
        </p>

        <label className="mt-8 block text-xs font-semibold text-slate-600">
          Email address

          <input
            className="mt-2 h-11 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100"
            type="email"
            placeholder="you@company.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
          />
        </label>

        {message && (
          <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
            {message}
          </p>
        )}

        <button
          className={`${buttonBase} mt-4 h-11 w-full bg-emerald-700 text-white hover:bg-emerald-800`}
          disabled={busy || !email}
          onClick={() => void signIn()}
        >
          {busy ? 'Signing in...' : 'Continue with email'}
        </button>

        <div className="my-6 flex items-center gap-3 text-[11px] text-slate-400">
          <span className="h-px flex-1 bg-slate-200" />
          or
          <span className="h-px flex-1 bg-slate-200" />
        </div>

        <button
          className={`${buttonBase} h-11 w-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-50`}
          onClick={() => {
            window.location.href = `${API}/auth/google`;
          }}
        >
          <span className="font-bold text-blue-600">G</span>
          Continue with Google
        </button>
      </div>
    </div>
  );
}

function EmailList({
  rows,
  view,
  loading,
}: {
  rows: Email[];
  view: 'queued' | 'scheduled' | 'sent';
  loading: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      {loading ? (
        <div className="flex min-h-72 items-center justify-center text-sm text-slate-400">
          Loading emails...
        </div>
      ) : rows.length === 0 ? (
        <div className="flex min-h-72 flex-col items-center justify-center px-6 text-center">
          <Mail className="mb-3 text-slate-300" size={26} />

          <h2 className="text-sm font-semibold text-slate-700">
            No {view} emails
          </h2>
        </div>
      ) : (
        <div className="divide-y divide-slate-100">
          {rows.map((row) => (
            <article
              key={row.id}
              className="grid gap-3 px-5 py-4 sm:grid-cols-[minmax(150px,1.2fr)_minmax(150px,1fr)_minmax(130px,.9fr)] sm:items-center sm:px-6"
            >
              <div>
                <p className="truncate text-sm font-semibold text-slate-800">
                  To: {row.recipientEmail}
                </p>

                <p className="mt-1 text-xs text-slate-400">
                  {formatTime(
                    view === 'sent'
                      ? row.sentAt
                      : row.scheduledAt
                  )}
                </p>
              </div>

              <div>
                <p className="truncate text-sm text-slate-700">
                  {row.subject}
                </p>

                <p className="mt-1 truncate text-xs text-slate-400">
                  {preview(row.body)}
                </p>
              </div>

              <span
                className={`justify-self-start rounded-full px-2.5 py-1 text-[10px] font-bold ${
                  row.status === 'SENT'
                    ? 'bg-emerald-50 text-emerald-700'
                    : row.status === 'FAILED'
                    ? 'bg-red-50 text-red-700'
                    : row.status === 'PROCESSING'
                    ? 'bg-amber-50 text-amber-700'
                    : 'bg-slate-100 text-slate-600'
                }`}
              >
                {row.status === 'QUEUED'
                  ? 'Queued'
                  : row.status === 'PROCESSING'
                  ? 'Sending'
                  : row.status === 'FAILED'
                  ? 'Failed'
                  : row.status === 'SENT'
                  ? 'Sent'
                  : 'Scheduled'}
              </span>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function Compose({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const [recipients, setRecipients] = useState<string[]>([]);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [start, setStart] = useState(
    new Date(Date.now() + 120000)
      .toISOString()
      .slice(0, 16)
  );
  const [delaySeconds, setDelaySeconds] = useState('2');
  const [hourlyLimit, setHourlyLimit] = useState('200');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const parseRecipients = (text: string) => {
    const valid =
      text.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g) ?? [];

    setRecipients([
      ...new Set(valid.map((email) => email.toLowerCase())),
    ]);
  };

  const submit = async () => {
    setBusy(true);
    setMessage('');

    try {
      const scheduledAt = new Date(start);

      if (
        Number.isNaN(scheduledAt.getTime()) ||
        scheduledAt.getTime() <= Date.now()
      ) {
        throw new Error(
          'Choose a future schedule date and time.'
        );
      }

      if (!recipients.length) {
        throw new Error(
          'Upload a file containing at least one valid email address.'
        );
      }

      await api('/api/campaigns', {
        method: 'POST',
        headers: {
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          name: subject || 'Email campaign',
          subject,
          body,
          recipients,
          startTime: scheduledAt.toISOString(),
          delayMs: Number(delaySeconds) * 1000,
          hourlyLimit: Number(hourlyLimit),
        }),
      });

      onDone();
    } catch (reason) {
      setMessage(
        reason instanceof Error
          ? reason.message
          : 'Unable to schedule email'
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 p-4 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-[680px] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
        <div className="flex items-start justify-between border-b border-slate-100 px-6 py-5 sm:px-8">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-emerald-600">
              New message
            </p>

            <h2 className="mt-2 text-xl font-bold text-slate-900">
              Compose email
            </h2>
          </div>

          <button
            className="grid h-8 w-8 place-items-center rounded-md text-slate-400 hover:bg-slate-100"
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </div>

        <div className="overflow-y-auto px-6 py-5 sm:px-8">
          <label className="block text-xs font-semibold text-slate-600">
            Recipient CSV/TXT

            <input
              className="mt-2 block h-11 w-full cursor-pointer rounded-lg border border-slate-200 px-3 py-2 text-xs outline-none file:mr-3 file:rounded-md file:border-0 file:bg-emerald-50 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-emerald-700"
              type="file"
              accept=".csv,.txt"
              onChange={(event) => {
                const file = event.target.files?.[0];

                if (file) {
                  const reader = new FileReader();

                  reader.onload = () =>
                    parseRecipients(String(reader.result));

                  reader.readAsText(file);
                }
              }}
            />

            <span
              className={`mt-2 block text-xs font-normal ${
                recipients.length
                  ? 'text-emerald-700'
                  : 'text-slate-400'
              }`}
            >
              {recipients.length
                ? `${recipients.length} unique recipients detected`
                : 'Email column or one address per line'}
            </span>
          </label>

          <label className="mt-5 block text-xs font-semibold text-slate-600">
            Subject

            <input
              className="mt-2 h-11 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100"
              value={subject}
              onChange={(event) =>
                setSubject(event.target.value)
              }
              placeholder="Subject"
            />
          </label>

          <label className="mt-5 block text-xs font-semibold text-slate-600">
            Message

            <textarea
              className="mt-2 min-h-28 w-full resize-y rounded-lg border border-slate-200 px-3 py-3 text-sm outline-none focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100"
              value={body}
              onChange={(event) =>
                setBody(event.target.value)
              }
              placeholder="Write your message..."
            />
          </label>

          <div className="mt-5 grid gap-4 sm:grid-cols-3">
            <label className="text-xs font-semibold text-slate-600">
              Schedule date and time

              <input
                className="mt-2 h-11 w-full rounded-lg border border-slate-200 px-3 text-xs outline-none focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100"
                type="datetime-local"
                value={start}
                onChange={(event) =>
                  setStart(event.target.value)
                }
              />
            </label>

            <label className="text-xs font-semibold text-slate-600">
              Delay between emails

              <input
                className="mt-2 h-11 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100"
                type="number"
                min="0"
                step="1"
                value={delaySeconds}
                onChange={(event) =>
                  setDelaySeconds(event.target.value)
                }
              />

              <span className="mt-1 block text-[11px] font-normal text-slate-400">
                seconds
              </span>
            </label>

            <label className="text-xs font-semibold text-slate-600">
              Hourly email limit

              <input
                className="mt-2 h-11 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100"
                type="number"
                min="1"
                value={hourlyLimit}
                onChange={(event) =>
                  setHourlyLimit(event.target.value)
                }
              />

              <span className="mt-1 block text-[11px] font-normal text-slate-400">
                emails/hour
              </span>
            </label>
          </div>

          {message && (
            <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
              {message}
            </p>
          )}
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-slate-100 px-6 py-4 sm:flex-row sm:justify-end sm:px-8">
          <button
            className={`${buttonBase} h-10 border border-slate-200 px-4 text-slate-600 hover:bg-slate-50`}
            onClick={onClose}
          >
            Cancel
          </button>

          <button
            className={`${buttonBase} h-10 bg-emerald-700 px-4 text-white hover:bg-emerald-800`}
            disabled={
              busy ||
              !recipients.length ||
              !subject.trim() ||
              !body.trim()
            }
            onClick={() => void submit()}
          >
            {busy ? (
              'Scheduling...'
            ) : (
              <>
                <Send size={15} />
                Schedule email
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

//jikjyuh