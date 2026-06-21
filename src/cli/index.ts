#!/usr/bin/env node
import { Command } from 'commander'
const program = new Command()
program.name('loop-e2e').description('AI-driven E2E verification loop').version('0.0.0')
program.parse()
