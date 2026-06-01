import Link from "next/link"
import {
  ArrowRight,
  CheckCircle2,
  KeyRound,
  LockKeyhole,
  Mic,
  RadioTower,
  Server,
  ShieldCheck,
  Smartphone,
  TerminalSquare,
} from "lucide-react"

const setupSteps = [
  {
    title: "Create your account",
    description: "Use Hello from Safari, Chrome, or any mobile browser.",
    icon: CheckCircle2,
  },
  {
    title: "Add your provider key",
    description: "Store your OpenAI key server-side so the browser never exposes it.",
    icon: KeyRound,
  },
  {
    title: "Connect your Mac",
    description: "Run the local connector next to OpenClaw, GBrain, or your own agent.",
    icon: TerminalSquare,
  },
  {
    title: "Talk from the site",
    description: "The public relay handles voice while your private agent stays private.",
    icon: Mic,
  },
]

const statusItems = [
  ["Domain", "hello.capnio.pro"],
  ["Runtime", "VPS relay + web app"],
  ["Agent route", "Private secure bridge"],
  ["Repository", "Public MIT fork"],
]

export default function Home() {
  return (
    <main className="min-h-screen bg-[#f7f3ec] text-[#171412]">
      <header className="border-b border-[#d8d0c4] bg-[#fffaf2]/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
          <Link href="/" className="flex items-center gap-3" aria-label="Hello home">
            <span className="flex size-9 items-center justify-center rounded-md bg-[#171412] text-[#fffaf2]">
              <RadioTower className="size-5" />
            </span>
            <span className="text-lg font-semibold tracking-normal">Hello Capnio</span>
          </Link>
          <nav className="flex items-center gap-2 text-sm">
            <a
              href="#setup"
              className="hidden rounded-md px-3 py-2 text-[#665f58] transition hover:bg-[#efe7da] hover:text-[#171412] sm:inline-flex"
            >
              Setup
            </a>
            <a
              href="#status"
              className="hidden rounded-md px-3 py-2 text-[#665f58] transition hover:bg-[#efe7da] hover:text-[#171412] sm:inline-flex"
            >
              Status
            </a>
            <a
              href="https://github.com/kameldhakwani90/voiceclaw"
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-[#cfc5b8] bg-white px-3 font-medium transition hover:border-[#171412]"
            >
              GitHub
              <ArrowRight className="size-4" />
            </a>
          </nav>
        </div>
      </header>

      <section className="mx-auto grid max-w-6xl items-center gap-10 px-5 py-12 md:min-h-[calc(100svh-4rem)] md:grid-cols-[minmax(0,1fr)_420px] md:py-16">
        <div>
          <div className="mb-5 inline-flex items-center gap-2 rounded-md border border-[#d8d0c4] bg-white px-3 py-2 text-sm text-[#665f58]">
            <span className="size-2 rounded-full bg-[#2f8f62]" />
            VPS-first voice app
          </div>
          <h1 className="max-w-3xl text-5xl font-semibold leading-none tracking-normal sm:text-6xl">
            Talk to your private agent from a public website.
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-[#665f58]">
            Hello runs at <strong className="font-semibold text-[#171412]">hello.capnio.pro</strong>.
            The browser connects to the VPS relay, and the relay reaches your local
            OpenClaw-compatible agent through a secure bridge.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <a
              href="#setup"
              className="inline-flex h-12 items-center justify-center gap-2 rounded-md bg-[#171412] px-5 text-sm font-semibold text-[#fffaf2] transition hover:bg-[#3a332d]"
            >
              <Smartphone className="size-4" />
              Start from the site
            </a>
            <a
              href="#status"
              className="inline-flex h-12 items-center justify-center gap-2 rounded-md border border-[#cfc5b8] bg-white px-5 text-sm font-semibold transition hover:border-[#171412]"
            >
              <Server className="size-4" />
              View deployment status
            </a>
          </div>
        </div>

        <div className="rounded-md border border-[#d8d0c4] bg-[#171412] p-5 text-[#fffaf2] shadow-[0_20px_60px_rgba(23,20,18,0.18)]">
          <div className="flex items-center justify-between border-b border-white/15 pb-4">
            <div>
              <p className="text-sm text-white/60">Live route</p>
              <p className="mt-1 font-mono text-sm">iPhone → VPS → Mac agent</p>
            </div>
            <span className="flex size-10 items-center justify-center rounded-md bg-[#2f8f62]">
              <Mic className="size-5" />
            </span>
          </div>
          <div className="mt-6 space-y-3">
            <ConsoleLine label="site" value="https://hello.capnio.pro" />
            <ConsoleLine label="relay" value="wss://hello.capnio.pro/ws" />
            <ConsoleLine label="brain" value="OpenAI-compatible local endpoint" />
            <ConsoleLine label="secrets" value="server-side only" />
          </div>
          <div className="mt-6 rounded-md border border-white/15 bg-white/5 p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium">
              <LockKeyhole className="size-4 text-[#7dd6a2]" />
              Private by default
            </div>
            <p className="text-sm leading-6 text-white/68">
              OpenClaw, GBrain, local files, and tools stay on the user machine.
              The public app only brokers the voice session and authenticated route.
            </p>
          </div>
        </div>
      </section>

      <section id="setup" className="border-t border-[#d8d0c4] bg-white px-5 py-14">
        <div className="mx-auto max-w-6xl">
          <div className="max-w-2xl">
            <p className="text-sm font-semibold uppercase text-[#8f4b34]">Setup</p>
            <h2 className="mt-2 text-3xl font-semibold tracking-normal">
              The account flow we are building.
            </h2>
          </div>
          <div className="mt-8 grid gap-4 md:grid-cols-4">
            {setupSteps.map((step) => (
              <div key={step.title} className="rounded-md border border-[#d8d0c4] bg-[#fffaf2] p-5">
                <step.icon className="size-5 text-[#8f4b34]" />
                <h3 className="mt-4 font-semibold">{step.title}</h3>
                <p className="mt-3 text-sm leading-6 text-[#665f58]">{step.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="status" className="px-5 py-14">
        <div className="mx-auto grid max-w-6xl gap-8 md:grid-cols-[0.75fr_1fr]">
          <div>
            <p className="text-sm font-semibold uppercase text-[#8f4b34]">Status</p>
            <h2 className="mt-2 text-3xl font-semibold tracking-normal">
              VPS entrypoint first, voice loop next.
            </h2>
            <p className="mt-4 leading-7 text-[#665f58]">
              This public page is the first deployed surface. Next chunks add auth,
              encrypted key storage, relay configuration, and the Mac mini bridge.
            </p>
          </div>
          <div className="grid gap-3">
            {statusItems.map(([label, value]) => (
              <div
                key={label}
                className="flex items-center justify-between rounded-md border border-[#d8d0c4] bg-white p-4"
              >
                <span className="text-sm text-[#665f58]">{label}</span>
                <span className="text-right font-mono text-sm">{value}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <footer className="border-t border-[#d8d0c4] px-5 py-8 text-sm text-[#665f58]">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <span>Hello Capnio</span>
          <span className="inline-flex items-center gap-2">
            <ShieldCheck className="size-4" />
            Public MIT repo, private user agents.
          </span>
        </div>
      </footer>
    </main>
  )
}

function ConsoleLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[72px_1fr] gap-3 rounded-md bg-white/5 px-3 py-2 font-mono text-sm">
      <span className="text-white/45">{label}</span>
      <span className="truncate text-white/82">{value}</span>
    </div>
  )
}
