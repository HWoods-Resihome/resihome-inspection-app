#!/usr/bin/env ruby
# frozen_string_literal: true
#
# Idempotently add a source file (already copied onto disk under ios/App/App/)
# to the "App" Xcode target so it actually compiles. Capacitor's generated
# project won't pick up a file just because it's in the folder — it must be a
# build-file reference in project.pbxproj. Uses the `xcodeproj` gem, which ships
# with fastlane (preinstalled on GitHub's macOS runners).
#
# Usage: ruby add_to_xcodeproj.rb <path/to/App.xcodeproj/project.pbxproj> <Filename.swift>

require 'xcodeproj'

pbxproj_path = ARGV[0] or abort('usage: add_to_xcodeproj.rb <project.pbxproj> <Filename>')
filename = ARGV[1] or abort('usage: add_to_xcodeproj.rb <project.pbxproj> <Filename>')

project = Xcodeproj::Project.open(pbxproj_path)
target = project.targets.find { |t| t.name == 'App' } or abort('App target not found')

# Already a build file in the target? Then we're done (idempotent re-runs).
in_target = target.source_build_phase.files.any? do |bf|
  bf.file_ref && bf.file_ref.display_name == filename
end
if in_target
  puts "   #{filename} already in App target"
  exit 0
end

# The "App" source group (source_tree rooted at ios/App/App).
app_group = project.main_group.find_subpath('App', true)
ref = app_group.files.find { |f| f.display_name == filename }
ref ||= app_group.new_file(filename) # path relative to the group
target.add_file_references([ref])
project.save
puts "   added #{filename} to App target"
