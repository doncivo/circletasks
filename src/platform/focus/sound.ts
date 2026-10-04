import type { SoundPlayer } from './types';

/**
 * Lecteur du son de fin (F-04 D4) : un élément `Audio` lit le fichier embarqué au volume du système, sans API Rust. Une lecture
 * refusée (le navigateur exige parfois un geste de l'utilisateur) est ignorée : le son n'est jamais la seule indication de la fin.
 */
export function createHtmlAudioPlayer(url: string): SoundPlayer {
  let audio: HTMLAudioElement | null = null;
  return {
    async play() {
      try {
        audio ??= new Audio(url);
        audio.currentTime = 0;
        await audio.play();
      } catch {
        // Lecture impossible : le texte et l'anneau signalent la fin.
      }
    },
  };
}

/** Faux (tests) : compte les lectures. */
export interface FakeSoundPlayer extends SoundPlayer {
  plays(): number;
}

export function createFakeSoundPlayer(): FakeSoundPlayer {
  let count = 0;
  return {
    play: () => {
      count += 1;
      return Promise.resolve();
    },
    plays: () => count,
  };
}
