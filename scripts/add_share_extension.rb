#!/usr/bin/env ruby
# scripts/add_share_extension.rb
#
# Wires the betslip share feature into ios/App/App.xcodeproj:
#
#   1. Adds App/CANativePlugin.swift to the App target (Apple Vision OCR + the
#      share-extension handoff, exposed to the web layer as window.CANative).
#   2. Creates the CappingAlphaShare app-extension target, with its own
#      Info.plist and entitlements, and embeds it in the app.
#   3. Points both targets at App.entitlements / CappingAlphaShare.entitlements so
#      they share the group.com.cappingalpha.app container.
#
# IDEMPOTENT: safe to re-run after `npx cap sync ios` regenerates parts of the
# project. Anything already present is left alone.
#
# Run:  ruby scripts/add_share_extension.rb
#   or: CA_TEAM_ID=XXXXXXXXXX ruby scripts/add_share_extension.rb
#
# Passing CA_TEAM_ID also stamps DEVELOPMENT_TEAM on BOTH targets, which is the
# only project-file change signing needs. Everything after that is automatic:
#
#   xcodebuild -project ios/App/App.xcodeproj -scheme App \
#              -allowProvisioningUpdates -destination 'generic/platform=iOS' build
#
# With automatic signing, that command REGISTERS the App Group
# "group.com.cappingalpha.app" on the developer portal and regenerates both
# provisioning profiles by itself. There is no website step and no capability
# checkbox to tick, because App.entitlements and CappingAlphaShare.entitlements
# already declare the group.
#
# THE ONE THING THAT IS NOT AUTOMATABLE: Xcode has to be signed in to an Apple
# Developer account first (Xcode > Settings > Accounts), which needs a password
# and a 2FA prompt. App Groups also requires a PAID membership; a free Apple ID
# can sideload to your own phone but cannot use them.

require 'xcodeproj'

ROOT = File.expand_path('..', __dir__)
PROJECT_PATH = File.join(ROOT, 'ios', 'App', 'App.xcodeproj')
EXT_NAME = 'CappingAlphaShare'
APP_BUNDLE_ID = 'com.cappingalpha.app'
EXT_BUNDLE_ID = "#{APP_BUNDLE_ID}.share"
DEPLOYMENT_TARGET = '15.0'

abort "Project not found at #{PROJECT_PATH}" unless File.exist?(PROJECT_PATH)

project = Xcodeproj::Project.open(PROJECT_PATH)
app_target = project.targets.find { |t| t.name == 'App' }
abort 'App target not found' unless app_target

changed = false

# ── 1. CANativePlugin.swift on the App target ────────────────────────────────
plugin_rel = 'App/CANativePlugin.swift'
already = app_target.source_build_phase.files_references.any? { |r| r && r.path.to_s.end_with?('CANativePlugin.swift') }
if already
  puts '= CANativePlugin.swift already on the App target'
else
  app_group = project.main_group.find_subpath('App', true)
  ref = app_group.files.find { |f| f.path.to_s.end_with?('CANativePlugin.swift') }
  ref ||= app_group.new_reference(File.join(ROOT, 'ios', 'App', plugin_rel))
  app_target.add_file_references([ref])
  puts '+ added CANativePlugin.swift to the App target'
  changed = true
end

# ── 2. The share extension target ────────────────────────────────────────────
ext_target = project.targets.find { |t| t.name == EXT_NAME }
if ext_target
  puts "= #{EXT_NAME} target already exists"
else
  ext_target = project.new_target(:app_extension, EXT_NAME, :ios, DEPLOYMENT_TARGET)
  ext_group = project.main_group.find_subpath(EXT_NAME, true)
  ext_group.set_source_tree('SOURCE_ROOT')
  ext_group.set_path(EXT_NAME)

  src = ext_group.new_reference(File.join(ROOT, 'ios', 'App', EXT_NAME, 'ShareViewController.swift'))
  ext_target.add_file_references([src])
  ext_group.new_reference(File.join(ROOT, 'ios', 'App', EXT_NAME, 'Info.plist'))
  ext_group.new_reference(File.join(ROOT, 'ios', 'App', EXT_NAME, "#{EXT_NAME}.entitlements"))

  ext_target.build_configurations.each do |config|
    s = config.build_settings
    s['PRODUCT_BUNDLE_IDENTIFIER'] = EXT_BUNDLE_ID
    s['PRODUCT_NAME'] = '$(TARGET_NAME)'
    s['INFOPLIST_FILE'] = "#{EXT_NAME}/Info.plist"
    s['CODE_SIGN_ENTITLEMENTS'] = "#{EXT_NAME}/#{EXT_NAME}.entitlements"
    s['CODE_SIGN_STYLE'] = 'Automatic'
    s['IPHONEOS_DEPLOYMENT_TARGET'] = DEPLOYMENT_TARGET
    s['SWIFT_VERSION'] = '5.0'
    s['TARGETED_DEVICE_FAMILY'] = '1,2'
    s['SKIP_INSTALL'] = 'YES'
    s['LD_RUNPATH_SEARCH_PATHS'] = ['$(inherited)', '@executable_path/Frameworks', '@executable_path/../../Frameworks']
    # An extension is memory-capped by the OS. Vision is the whole job here, so
    # keep the binary lean: no Capacitor, no web view, nothing else linked in.
    s['ENABLE_BITCODE'] = 'NO'
  end

  # Embed the extension in the app, and make the app depend on it so a plain
  # Build of the app always produces a current extension.
  app_target.add_dependency(ext_target)
  embed_phase = app_target.build_phases.find do |p|
    p.is_a?(Xcodeproj::Project::Object::PBXCopyFilesBuildPhase) && p.name == 'Embed App Extensions'
  end
  unless embed_phase
    embed_phase = app_target.new_copy_files_build_phase('Embed App Extensions')
    embed_phase.symbol_dst_subfolder_spec = :plug_ins
  end
  build_file = embed_phase.add_file_reference(ext_target.product_reference, true)
  build_file.settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }

  puts "+ created the #{EXT_NAME} extension target and embedded it in App"
  changed = true
end

# ── 2b. MainViewController: registers CANativePlugin ─────────────────────────
# Capacitor only auto-registers plugins that come from npm packages. An app-local
# plugin is compiled in but never reaches the bridge, so window.Capacitor.Plugins
# .CANative is absent and the share hand-off silently does nothing. MainViewController
# registers it; the storyboard has to point at that class for it to run.
mvc_rel = 'App/MainViewController.swift'
mvc_on_target = app_target.source_build_phase.files_references.any? { |r| r && r.path.to_s.end_with?('MainViewController.swift') }
if mvc_on_target
  puts '= MainViewController.swift already on the App target'
else
  g = project.main_group.find_subpath('App', true)
  ref = g.files.find { |f| f.path.to_s.end_with?('MainViewController.swift') }
  ref ||= g.new_reference(File.join(ROOT, 'ios', 'App', mvc_rel))
  app_target.add_file_references([ref])
  puts '+ added MainViewController.swift to the App target'
  changed = true
end

storyboard = File.join(ROOT, 'ios', 'App', 'App', 'Base.lproj', 'Main.storyboard')
if File.exist?(storyboard)
  sb = File.read(storyboard)
  if sb.include?('customClass="CAPBridgedViewController"') || sb.include?('customClass="CAPBridgeViewController"')
    sb = sb.sub(/<viewController id="BYZ-38-t0r"[^>]*\/>/,
                '<viewController id="BYZ-38-t0r" customClass="MainViewController" customModule="App" customModuleProvider="target" sceneMemberID="viewController"/>')
    File.write(storyboard, sb)
    puts '+ Main.storyboard now uses MainViewController (plugin registration)'
  else
    puts '= Main.storyboard already uses MainViewController'
  end
end

# ── 3. App target entitlements ───────────────────────────────────────────────
app_target.build_configurations.each do |config|
  want = 'App/App.entitlements'
  if config.build_settings['CODE_SIGN_ENTITLEMENTS'] != want
    config.build_settings['CODE_SIGN_ENTITLEMENTS'] = want
    changed = true
  end
end
puts '= App target points at App/App.entitlements'

# ── 4. Development team (optional) ───────────────────────────────────────────
# The ONLY project-file setting signing needs. Everything else (registering the
# App Group, minting profiles) is done by xcodebuild -allowProvisioningUpdates.
team = ENV['CA_TEAM_ID'].to_s.strip
if team.empty?
  puts '= no CA_TEAM_ID given, leaving DEVELOPMENT_TEAM alone'
elsif team !~ /\A[A-Z0-9]{10}\z/
  abort "CA_TEAM_ID must be the 10-character Team ID (got #{team.inspect})"
else
  [app_target, ext_target].compact.each do |t|
    t.build_configurations.each do |config|
      if config.build_settings['DEVELOPMENT_TEAM'] != team
        config.build_settings['DEVELOPMENT_TEAM'] = team
        changed = true
      end
    end
  end
  puts "+ DEVELOPMENT_TEAM = #{team} on App and #{EXT_NAME}"
end

if changed
  project.save
  puts "\nSaved #{PROJECT_PATH}"
else
  puts "\nNothing to change."
end

if team.empty?
  puts <<~NEXT

    Next, once (needs a password and a 2FA prompt, so it cannot be scripted):
      Xcode > Settings > Accounts > + > Apple ID, and sign in.
      App Groups needs a PAID Apple Developer membership.

    Then find your Team ID:
      security find-identity -p codesigning -v
    and re-run this with it:
      CA_TEAM_ID=XXXXXXXXXX ruby scripts/add_share_extension.rb
  NEXT
else
  puts <<~NEXT

    Project is fully configured. This registers the App Group and mints both
    profiles automatically (no developer portal, no capability checkbox):

      xcodebuild -project ios/App/App.xcodeproj -scheme App \\
                 -allowProvisioningUpdates \\
                 -destination 'generic/platform=iOS' build

    Then: share any bet from FanDuel or DraftKings and pick CappingAlpha.
  NEXT
end
