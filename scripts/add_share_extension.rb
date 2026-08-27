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
#
# WHAT THIS SCRIPT CANNOT DO, and Jack has to (both need the Apple Developer
# account, so they are not automatable from here):
#   - Register the App Group "group.com.cappingalpha.app" on the developer portal
#     and tick App Groups on BOTH targets in Signing & Capabilities.
#   - Pick the team / signing identity for the new CappingAlphaShare target.

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

# ── 3. App target entitlements ───────────────────────────────────────────────
app_target.build_configurations.each do |config|
  want = 'App/App.entitlements'
  if config.build_settings['CODE_SIGN_ENTITLEMENTS'] != want
    config.build_settings['CODE_SIGN_ENTITLEMENTS'] = want
    changed = true
  end
end
puts '= App target points at App/App.entitlements'

if changed
  project.save
  puts "\nSaved #{PROJECT_PATH}"
else
  puts "\nNothing to change."
end

puts <<~NEXT

  Still needs you, in Xcode (both require the Apple Developer account):
    1. Signing & Capabilities -> App: add "App Groups", tick group.com.cappingalpha.app
    2. Signing & Capabilities -> #{EXT_NAME}: set the Team, add the same App Group

  Then: share any bet from FanDuel or DraftKings and pick CappingAlpha.
NEXT
