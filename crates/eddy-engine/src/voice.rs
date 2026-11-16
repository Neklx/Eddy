use crate::command::{Param, Stage};
use eddy_dsp::biquad::{Biquad, Equalizer, FilterKind};
use eddy_dsp::compressor::Compressor;
use eddy_dsp::gate::Gate;
use eddy_dsp::leveler::AutoLeveler;
use eddy_dsp::suppressor::{HopAdapter, SpectralSuppressor};

/// The microphone chain from the Effects screen:
/// high-pass, noise removal, gate, EQ, compressor, auto level. Mono.
pub struct VoiceChain {
    hp: Biquad,
    hp_on: bool,
    sample_rate: f32,
    noise: HopAdapter,
    noise_on: bool,
    gate: Gate,
    gate_on: bool,
    eq: Equalizer,
    eq_on: bool,
    comp: Compressor,
    comp_on: bool,
    lev: AutoLeveler,
    lev_on: bool,
    gate_release_ms: f32,
}

impl VoiceChain {
    pub fn new(sample_rate: f32, max_block: usize) -> Self {
        let mut eq = Equalizer::new();
        eq.add_band(FilterKind::LowShelf { gain_db: 1.5 }, 150.0, 0.7, sample_rate);
        eq.add_band(FilterKind::Peaking { gain_db: -1.5 }, 400.0, 1.0, sample_rate);
        eq.add_band(FilterKind::Peaking { gain_db: 2.0 }, 3000.0, 1.0, sample_rate);
        Self {
            hp: Biquad::new(FilterKind::HighPass, 80.0, 0.707, sample_rate),
            hp_on: true,
            sample_rate,
            noise: HopAdapter::new(Box::new(SpectralSuppressor::new()), max_block),
            noise_on: true,
            gate: Gate::new(sample_rate),
            gate_on: true,
            eq, eq_on: true,
            comp: Compressor::new(sample_rate), comp_on: true,
            lev: AutoLeveler::new(sample_rate), lev_on: true,
            gate_release_ms: 120.0,
        }
    }

    /// Delay added by the chain (only the noise stage adds delay), in samples.
    pub fn latency_samples(&self) -> usize { if self.noise_on { self.noise.latency() } else { 0 } }

    pub fn compressor_reduction_db(&self) -> f32 { self.comp.reduction_db() }

    pub fn set_stage(&mut self, stage: Stage, on: bool) {
        match stage {
            Stage::HighPass => self.hp_on = on,
            Stage::Noise => self.noise_on = on,
            Stage::Gate => self.gate_on = on,
            Stage::Eq => self.eq_on = on,
            Stage::Compressor => self.comp_on = on,
            Stage::Leveler => self.lev_on = on,
        }
    }

    pub fn set_param(&mut self, p: Param, v: f32) {
        match p {
            Param::HighPassHz => self.hp.set(FilterKind::HighPass, v, 0.707, self.sample_rate),
            Param::NoiseStrength => self.noise.set_strength(v),
            Param::GateThresholdDb => self.gate.set_threshold_db(v),
            Param::GateReleaseMs => { self.gate_release_ms = v; self.gate.set_times(5.0, v, 80.0) }
            Param::CompThresholdDb => self.comp.set_threshold_db(v),
            Param::CompRatio => self.comp.set_ratio(v),
            Param::CompMakeupDb => self.comp.set_makeup_db(v),
            Param::LevelerTargetDb => self.lev.set_target_db(v),
        }
    }

    pub fn process(&mut self, buf: &mut [f32]) {
        if self.hp_on { self.hp.process(buf); }
        if self.noise_on { self.noise.process(buf); }
        if self.gate_on { self.gate.process(buf); }
        if self.eq_on { self.eq.process(buf); }
        if self.comp_on { self.comp.process(buf); }
        if self.lev_on { self.lev.process(buf); }
    }
}
