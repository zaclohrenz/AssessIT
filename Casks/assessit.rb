cask "assessit" do
  version "0.2.3"
  sha256 "d466b31494ff90bf1c024c812f29dfa0bcbd6d612b6cd2b666174ff3321699ac"

  url "https://github.com/zaclohrenz/AssessIT/releases/download/v#{version}/AssessIT-#{version}-macos-universal.zip"
  name "AssessIT"
  desc "Software risk assessment with AI-gathered evidence"
  homepage "https://github.com/zaclohrenz/AssessIT"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on :macos

  app "AssessIT.app"

  # Organizations can point an install at their own config (see README, "Rolling it out"):
  #   HOMEBREW_ASSESSIT_CONFIG_URL=https://intranet.example.com/assessit-config.json brew install --cask assessit
  # Homebrew only passes through environment variables whose names start with HOMEBREW_.
  config_url = ENV.fetch("HOMEBREW_ASSESSIT_CONFIG_URL", "").strip

  # AssessIT is free and ad-hoc signed rather than notarized, so the postflight clears the
  # download quarantine flag to let it open with a normal double-click.
  if config_url.empty?
    postflight_steps do
      run "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "{{appdir}}/AssessIT.app"]
    end
  else
    # base: :home resolves against the real home folder; "~" would land in the install sandbox.
    # Upgrades without the variable skip this branch, so an existing URL is kept.
    postflight_steps do
      run "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "{{appdir}}/AssessIT.app"]
      mkdir_p "Library/Application Support/io.github.zaclohrenz.assessit", base: :home
      write_file "Library/Application Support/io.github.zaclohrenz.assessit/config-url", config_url, base: :home
    end
  end

  zap trash: [
    "~/Library/Application Support/io.github.zaclohrenz.assessit",
    "~/Library/Caches/io.github.zaclohrenz.assessit",
    "~/Library/WebKit/io.github.zaclohrenz.assessit",
  ]

  caveats <<~EOS
    AI research uses Claude Code with your own Claude account (no API keys).
    If it isn't set up, AssessIT offers a one-click "Install & sign in" button,
    or you can use any other AI chat (ChatGPT, Gemini, Copilot) by copy & paste.
  EOS
end
